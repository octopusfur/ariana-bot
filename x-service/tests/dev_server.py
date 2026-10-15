"""Run the X service locally against a FAKE X API — no X account, no network.

    XMCP_DIR=/path/to/xmcp python tests/dev_server.py

Prints the service URL and API key to use as X_SERVICE_URL / X_SERVICE_API_KEY,
then serves until Ctrl-C. Handy for trying the bot's X tools end to end without
spending a single API credit. Every request the fake X receives is printed."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import fake_x  # noqa: E402

KEY = "dev-" + "k" * 28


class _Logged(list):
    def append(self, item):
        method, path, headers, body = item
        scheme = (headers.get("authorization") or "NONE").split(" ")[0]
        print(f"[fake X] {method} {path}{('?' + headers.get('_query')) if headers.get('_query') else ''} auth={scheme} body={body}", flush=True)
        super().append(item)


fake = fake_x.FakeX()
fake.requests = _Logged()
fake.start()
os.environ.update({
    "X_OAUTH_CONSUMER_KEY": "dev_ck", "X_OAUTH_CONSUMER_SECRET": "dev_cs",
    "X_OAUTH_ACCESS_TOKEN": "dev_at", "X_OAUTH_ACCESS_TOKEN_SECRET": "dev_ats",
    "X_SERVICE_API_KEY": KEY, "X_API_BASE_URL": fake.url, "X_API_DEBUG": "0",
})
import app  # noqa: E402

app.upstream.load_openapi_spec = fake_x.spec
service, _ = app.build_app()

import uvicorn  # noqa: E402

port = int(os.getenv("PORT", "8799"))
print(f"\nX_SERVICE_URL=http://127.0.0.1:{port}\nX_SERVICE_API_KEY={KEY}\n(fake X API: signed in as @{fake_x.ME['username']})\n", flush=True)
uvicorn.run(service, host="127.0.0.1", port=port, log_level="warning")
