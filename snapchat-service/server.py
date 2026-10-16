"""server.py - HTTP face of the Snapchat bridge, for the Fly.io sidecar (mirrors the WhatsApp sidecar).

  main app -> sidecar : Authorization: Bearer $SNAP_API_SECRET
  sidecar -> main app : POST $MAIN_APP_URL/snapchat/inbound  (same secret in x-snap-secret)

Env: SNAP_API_SECRET (required), MAIN_APP_URL, SNAPCHAT_USER_UUID, SNAPCHAT_CONVERSATIONS (comma list),
     SNAP_POLL_SECONDS (default 20, min 10), SNAP_MAX_SENDS_PER_HOUR (default 30), PORT (default 8080)
"""
import base64
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import requests

from bridge import UNSUPPORTED, Bridge, SnapchatError, AuthError, is_uuid

SECRET = os.environ.get("SNAP_API_SECRET", "")
MAIN_APP_URL = os.environ.get("MAIN_APP_URL", "").rstrip("/")
POLL = max(10, int(os.environ.get("SNAP_POLL_SECONDS", "20")))
MAX_BODY = 25 * 1024 * 1024


def deliver(conversation_id, text):
    if not MAIN_APP_URL:
        return
    requests.post(
        MAIN_APP_URL + "/snapchat/inbound",
        json={"conversation_id": conversation_id, "text": text},
        headers={"x-snap-secret": SECRET},
        timeout=20,
    ).raise_for_status()


bridge = Bridge(
    on_inbound=deliver,
    my_uuid=os.environ.get("SNAPCHAT_USER_UUID", "").strip().lower(),
    conversations=[c.strip() for c in os.environ.get("SNAPCHAT_CONVERSATIONS", "").split(",") if c.strip()],
    max_sends_per_hour=int(os.environ.get("SNAP_MAX_SENDS_PER_HOUR", "30")),
    answer_all=os.environ.get("SNAP_ONLY_LISTED_CHATS", "").lower() not in ("1", "on", "true", "yes"),
)


def status():
    return {
        "connected": bridge.authenticated() and bool(bridge.my_uuid),
        "signed_in": bridge.authenticated(),
        "user_uuid_set": bool(bridge.my_uuid),
        "user_uuid": bridge.my_uuid or None,
        "conversations": sorted(bridge.conversations),
        "answer_all": bridge.answer_all,
        "chats_found": len(bridge.known),
        "paused": bridge.paused,
        "last_poll": bridge.last_poll,
        "last_error": bridge.last_error,
    }


def fail(code, msg):
    return code, {"error": msg}


def route(method, path, body, query):
    if path == "/status" and method == "GET":
        return 200, status()
    if path == "/session" and method == "POST":
        if body.get("user_uuid"):
            bridge.set_user_uuid(body["user_uuid"])
        if body.get("cookies"):
            sess = bridge.load_session(body["cookies"], body.get("bearer_token", ""))
        found = None
        if not bridge.my_uuid:
            try:
                found = bridge.discover_user_uuid()
            except Exception as e:
                bridge.last_error = f"could not find the account id: {e}"
        return 200, {**sess, **status(), "user_uuid_found": found}
        return fail(400, "cookies required")
    if path == "/diagnose" and method == "GET":
        return 200, bridge.diagnose()
    if path == "/discover-uuid" and method == "POST":
        found = bridge.discover_user_uuid()
        return 200, {**status(), "user_uuid_found": found}
    if path == "/session-uuid" and method == "POST":
        bridge.set_user_uuid(body.get("user_uuid", ""))
        return 200, status()
    if path == "/login" and method == "POST":
        if body.get("user_uuid"):
            bridge.set_user_uuid(body["user_uuid"])
        if not body.get("username") or not body.get("password"):
            return fail(400, "username and password required")
        out = bridge.login(body["username"], body["password"])
        found = None
        if not bridge.my_uuid:
            try:
                found = bridge.discover_user_uuid()
            except Exception as e:
                bridge.last_error = f"could not find the account id: {e}"
        return 200, {**out, **status(), "user_uuid_found": found}
    if path == "/logout" and method == "POST":
        bridge.logout()
        return 200, status()
    if path == "/pause" and method == "POST":
        bridge.paused = bool(body.get("paused", True))
        return 200, status()
    if path == "/conversations" and method == "GET":
        return 200, {"conversations": sorted(bridge.conversations)}
    if path == "/conversations" and method == "POST":
        return 200, {"conversations": bridge.set_conversations(body.get("add", []), body.get("remove", []), body.get("replace"))}
    if path == "/conversations/candidates" and method == "GET":
        return 200, {"candidates": bridge.candidates(), "note": "Suggestions only. Add the ones that are real chats with POST /conversations."}
    if path == "/send-text" and method == "POST":
        return 200, bridge.send_text(body.get("conversation_id", ""), body.get("text", ""))
    if path == "/send-media" and method == "POST":
        data = base64.b64decode(body.get("data_b64", ""), validate=True)
        if not data:
            return fail(400, "data_b64 required")
        return 200, bridge.send_media(body.get("conversation_id", ""), body.get("filename", "image.jpg"), data)
    if path == "/friends" and method == "GET":
        return 200, bridge._call("sync_friends")
    if path == "/friend-requests" and method == "GET":
        return 200, bridge._call("incoming_friend_requests")
    if path == "/add-friend" and method == "POST":
        if not is_uuid(body.get("user_id")):
            return fail(400, "user_id must be a UUID")
        return 200, bridge._call("add_friend", body["user_id"])
    if path.startswith("/lookup/") and method == "GET":
        uid = path.split("/", 2)[2]
        if not is_uuid(uid):
            return fail(400, "user id must be a UUID")
        return 200, bridge._call("lookup_user", uid)
    if path == "/feed/stories" and method == "GET":
        return 200, bridge._call("get_stories_feed")
    if path == "/feed/spotlight" and method == "GET":
        return 200, bridge._call("get_spotlight_feed")
    if path == "/download" and method == "POST":
        return 200, bridge.download(body.get("url", ""))
    for action, reason in UNSUPPORTED.items():
        if path == "/" + action.replace("_", "-") and method == "POST":
            return 501, {"error": reason, "supported": False}
    return fail(404, "not found")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep tokens/cookies out of logs
        sys.stderr.write("[snap] %s\n" % (fmt % args).split("?")[0])

    def _send(self, code, payload):
        raw = json.dumps(payload, default=lambda o: o.hex() if isinstance(o, (bytes, bytearray)) else str(o)).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authed(self):
        given = self.headers.get("Authorization", "")
        given = given[7:] if given.lower().startswith("bearer ") else self.headers.get("x-snap-secret", "")
        return bool(SECRET) and hmac.compare_digest(given.encode(), SECRET.encode())

    def _handle(self, method):
        url = urlparse(self.path)
        if url.path == "/ping":
            return self._send(200, {"ok": True})
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                return self._send(413, {"error": "body too large"})
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            code, payload = route(method, url.path, body, url.query)
        except AuthError as e:
            code, payload = 401, {"error": str(e)}
        except SnapchatError as e:
            code, payload = 502, {"error": str(e)}
        except (ValueError, TypeError) as e:
            code, payload = 400, {"error": f"bad request: {e}"}
        except Exception as e:
            code, payload = 500, {"error": f"{type(e).__name__}: {e}"}
        self._send(code, payload)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def poll_loop():
    while True:
        try:
            bridge.poll_once()
        except Exception as e:
            bridge.last_error = f"poll: {e}"
        time.sleep(POLL)


def main():
    if not SECRET:
        print("SNAP_API_SECRET must be set. Refusing to start.", file=sys.stderr)
        sys.exit(1)
    threading.Thread(target=poll_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    print(f"[snap] listening on :{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
