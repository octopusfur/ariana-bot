"""
Ariana's X service — a thin, hardened wrapper around X's official xmcp server
(https://github.com/xdevplatform/xmcp).

Why a wrapper and not a fork
────────────────────────────
xmcp ships with three things that are fine on a laptop and wrong on a server:

  1. It opens a browser and waits on 127.0.0.1 for an OAuth callback at startup.
     A Render container has no browser. Here the four OAuth1 values come from
     environment variables instead.
  2. Its /mcp endpoint has no authentication. Anyone who finds the URL could post
     as the account. Here every request needs the shared X-Api-Key.
  3. With no allowlist it exposes the entire X API (deletes, blocks, compliance
     jobs…). Here an unset allowlist falls back to the fifteen tools Ariana uses.

xmcp itself is not copied into this repo (it has no licence file). The Dockerfile
downloads one pinned commit into /opt/xmcp at build time and this file imports
it, replacing two of its functions at runtime. Nothing upstream is edited.

Idle behaviour
──────────────
There is no background work in this process: no timers, no polling, no
keep-alive. It does something only when a request arrives. On a Render plan that
spins idle services down, an incoming request is what wakes it.
"""

import hmac
import logging
import os
import sys
import time

sys.path.insert(0, os.environ.get("XMCP_DIR", "/opt/xmcp"))

import server as upstream  # noqa: E402  (xmcp's server.py, pinned at build time)
from oauthlib.oauth1 import Client as OAuth1Client  # noqa: E402

LOG = logging.getLogger("ariana.x_service")

# Every X API operation Ariana's bot can call — one per thing she can do. Anything
# else (lists, bookmarks, compliance jobs, blocking…) stays unloaded: the bot has
# no way to use it, so exposing it would only add risk.
DEFAULT_TOOLS = (
    # identity + core actions
    "getUsersMe",
    "getUsersByUsername",
    "createPosts",
    "likePost",
    "repostPost",
    "followUser",
    "unfollowUser",
    "createDirectMessagesByParticipantId",
    # reading
    "searchPostsRecent",
    "getUsersPosts",
    "getUsersTimeline",
    "getUsersMentions",
    "getDirectMessagesEvents",
    "getDirectMessagesEventsByParticipantId",
    # deleting (the bot only ever sends her own posts, and only after the creator confirms)
    "deletePosts",
)

OAUTH_ENV = (
    "X_OAUTH_CONSUMER_KEY",
    "X_OAUTH_CONSUMER_SECRET",
    "X_OAUTH_ACCESS_TOKEN",
    "X_OAUTH_ACCESS_TOKEN_SECRET",
)

MIN_KEY_LENGTH = 24


def require_env() -> str:
    """Fail at boot, naming every missing variable, never partially start."""
    missing = [name for name in OAUTH_ENV + ("X_SERVICE_API_KEY",) if not os.getenv(name, "").strip()]
    if missing:
        raise RuntimeError("Missing environment variables: " + ", ".join(missing))
    key = os.environ["X_SERVICE_API_KEY"].strip()
    if len(key) < MIN_KEY_LENGTH:
        raise RuntimeError(f"X_SERVICE_API_KEY is too short — use at least {MIN_KEY_LENGTH} random characters.")
    return key


def build_oauth1_client_from_env() -> OAuth1Client:
    """Replaces xmcp's interactive browser flow with the stored user tokens."""
    return OAuth1Client(
        client_key=os.environ["X_OAUTH_CONSUMER_KEY"].strip(),
        client_secret=os.environ["X_OAUTH_CONSUMER_SECRET"].strip(),
        resource_owner_key=os.environ["X_OAUTH_ACCESS_TOKEN"].strip(),
        resource_owner_secret=os.environ["X_OAUTH_ACCESS_TOKEN_SECRET"].strip(),
        signature_type="AUTH_HEADER",
    )


def apply_default_allowlist() -> None:
    """A blank allowlist means 'every tool' to xmcp — never allow that by accident."""
    if not os.getenv("X_API_TOOL_ALLOWLIST", "").strip():
        os.environ["X_API_TOOL_ALLOWLIST"] = ",".join(DEFAULT_TOOLS)


def with_spec_retry(original, attempts: int = 3, pause: float = 4.0):
    """The OpenAPI spec is fetched from api.x.com on every cold start. One slow
    response there should cost a few seconds, not a crash loop."""

    def load():
        for attempt in range(1, attempts + 1):
            try:
                return original()
            except Exception as exc:  # noqa: BLE001 - any failure here is retryable
                if attempt == attempts:
                    raise
                LOG.warning("OpenAPI spec fetch failed (%s); retry %d/%d", exc, attempt, attempts - 1)
                time.sleep(pause)

    return load


class ApiKeyGate:
    """Pure ASGI gate in front of the MCP app. /healthz is open and touches
    nothing; every other HTTP request needs the shared key."""

    def __init__(self, app, key: str):
        self.app = app
        self.key = key.encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":  # lifespan etc. pass straight through
            return await self.app(scope, receive, send)

        if scope.get("path") == "/healthz":
            return await self._reply(send, 200, b"ok", b"text/plain")

        supplied = b""
        for name, value in scope.get("headers", []):
            if name == b"x-api-key":
                supplied = value
                break
        if not hmac.compare_digest(supplied, self.key):
            return await self._reply(send, 401, b'{"error":"unauthorized"}', b"application/json")

        return await self.app(scope, receive, send)

    @staticmethod
    async def _reply(send, status: int, body: bytes, content_type: bytes):
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", content_type), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


def build_app():
    key = require_env()
    apply_default_allowlist()
    upstream.build_oauth1_client = build_oauth1_client_from_env
    upstream.load_openapi_spec = with_spec_retry(upstream.load_openapi_spec)

    started = time.time()
    mcp = upstream.create_mcp()
    # stateless + plain JSON: nothing is remembered between requests, so a
    # restart or a wake-up can never leave a client holding a dead session.
    inner = mcp.http_app(path="/mcp", stateless_http=True, json_response=True,
                         host_origin_protection=None)
    LOG.info("X service ready in %.1fs", time.time() - started)
    return ApiKeyGate(inner, key), mcp


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    app, _ = build_app()
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "10000")), log_level="info")


if __name__ == "__main__":
    main()
