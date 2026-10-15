"""X service tests. Run from x-service/ with the xmcp checkout on XMCP_DIR:
    XMCP_DIR=/path/to/xmcp python -m unittest discover -s tests -v
Drives the REAL xmcp code (pinned commit) against a fake X API."""

import asyncio
import importlib
import json
import os
import socket
import sys
import threading
import time
import unittest

import httpx

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import fake_x  # noqa: E402

KEY = "k" * 32
BASE_ENV = {
    "X_OAUTH_CONSUMER_KEY": "ck_test", "X_OAUTH_CONSUMER_SECRET": "cs_test",
    "X_OAUTH_ACCESS_TOKEN": "at_test", "X_OAUTH_ACCESS_TOKEN_SECRET": "ats_test",
    "X_SERVICE_API_KEY": KEY, "X_API_DEBUG": "0",
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def rpc(client, url, method, params=None, key=KEY, headers=None, rid=1):
    h = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
    if key is not None:
        h["x-api-key"] = key
    h.update(headers or {})
    return client.post(url, headers=h, json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


class ServiceCase(unittest.TestCase):
    allowlist = None  # None → leave unset so the built-in default applies

    @classmethod
    def setUpClass(cls):
        cls.fake = fake_x.FakeX().start()
        cls._saved = dict(os.environ)
        os.environ.update(BASE_ENV)
        os.environ["X_API_BASE_URL"] = cls.fake.url
        os.environ.pop("X_API_TOOL_ALLOWLIST", None)
        if cls.allowlist is not None:
            os.environ["X_API_TOOL_ALLOWLIST"] = cls.allowlist
        import app as appmod
        cls.appmod = importlib.reload(appmod)
        cls.appmod.upstream.load_openapi_spec = fake_x.spec  # no network for the spec
        cls.app, cls.mcp = cls.appmod.build_app()
        import uvicorn
        cls.port = free_port()
        cls.server = uvicorn.Server(uvicorn.Config(cls.app, host="127.0.0.1", port=cls.port, log_level="warning"))
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()
        for _ in range(100):
            try:
                httpx.get(f"http://127.0.0.1:{cls.port}/healthz", timeout=0.5)
                break
            except Exception:
                time.sleep(0.1)
        cls.url = f"http://127.0.0.1:{cls.port}/mcp"
        cls.http = httpx.Client(timeout=10)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(5)
        cls.fake.stop()
        os.environ.clear()
        os.environ.update(cls._saved)

    def tool_names(self):
        r = rpc(self.http, self.url, "tools/list")
        self.assertEqual(r.status_code, 200, r.text)
        return sorted(t["name"] for t in r.json()["result"]["tools"])


class TestDefaults(ServiceCase):
    def test_healthz_is_open_and_touches_nothing_upstream(self):
        before = len(self.fake.requests)
        r = httpx.get(f"http://127.0.0.1:{self.port}/healthz")
        self.assertEqual((r.status_code, r.text), (200, "ok"))
        self.assertEqual(len(self.fake.requests), before)

    def test_mcp_requires_the_key(self):
        self.assertEqual(rpc(self.http, self.url, "tools/list", key=None).status_code, 401)
        self.assertEqual(rpc(self.http, self.url, "tools/list", key="wrong" * 8).status_code, 401)
        self.assertEqual(rpc(self.http, self.url, "tools/list", key=KEY[:-1]).status_code, 401)

    def test_only_the_eight_default_tools_load(self):
        self.assertEqual(self.tool_names(), sorted(self.appmod.DEFAULT_TOOLS))
        for dangerous in ("deletePosts", "searchPostsRecent", "blockUsersDms"):
            self.assertNotIn(dangerous, self.tool_names())

    def test_works_behind_a_public_hostname(self):
        r = rpc(self.http, self.url, "tools/list", headers={"host": "ariana-x.onrender.com"})
        self.assertEqual(r.status_code, 200, r.text)

    def test_a_post_reaches_x_signed_with_the_stored_tokens(self):
        r = rpc(self.http, self.url, "tools/call", {"name": "createPosts", "arguments": {"text": "hello from ariana"}})
        self.assertEqual(r.status_code, 200, r.text)
        method, path, headers, body = self.fake.requests[-1]
        self.assertEqual((method, path), ("POST", "/2/tweets"))
        self.assertEqual(body, {"text": "hello from ariana"})
        auth = headers.get("authorization", "")
        self.assertTrue(auth.startswith("OAuth "))
        self.assertIn('oauth_consumer_key="ck_test"', auth)
        self.assertIn('oauth_token="at_test"', auth)
        self.assertNotIn("cs_test", auth)   # secrets sign, they are never sent
        self.assertNotIn("ats_test", auth)


class TestAllowlistOverride(ServiceCase):
    allowlist = "getUsersMe,searchPostsRecent"

    def test_explicit_allowlist_wins(self):
        self.assertEqual(self.tool_names(), ["getUsersMe", "searchPostsRecent"])


class TestBoot(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)
        import app as appmod
        self.appmod = importlib.reload(appmod)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)

    def test_missing_variables_are_all_named(self):
        for k in list(BASE_ENV):
            os.environ.pop(k, None)
        with self.assertRaises(RuntimeError) as ctx:
            self.appmod.require_env()
        for name in BASE_ENV:
            if name != "X_API_DEBUG":
                self.assertIn(name, str(ctx.exception))

    def test_short_api_key_is_refused(self):
        os.environ.update(BASE_ENV)
        os.environ["X_SERVICE_API_KEY"] = "short"
        with self.assertRaises(RuntimeError):
            self.appmod.require_env()

    def test_blank_allowlist_means_default_not_everything(self):
        os.environ["X_API_TOOL_ALLOWLIST"] = "   "
        self.appmod.apply_default_allowlist()
        self.assertEqual(os.environ["X_API_TOOL_ALLOWLIST"].split(","), list(self.appmod.DEFAULT_TOOLS))

    def test_spec_fetch_retries_then_succeeds(self):
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise ConnectionError("slow")
            return {"ok": True}

        self.assertEqual(self.appmod.with_spec_retry(flaky, attempts=3, pause=0)(), {"ok": True})
        self.assertEqual(len(calls), 3)

    def test_spec_fetch_gives_up_after_the_last_attempt(self):
        def dead():
            raise ConnectionError("down")

        with self.assertRaises(ConnectionError):
            self.appmod.with_spec_retry(dead, attempts=2, pause=0)()


if __name__ == "__main__":
    unittest.main()
