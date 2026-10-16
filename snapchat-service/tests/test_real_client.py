"""Drives the REAL SnapchatClient through the Bridge and the HTTP routes, faking only the network.

The earlier tests used a stand-in client, which hid a bug: the real client's is_authenticated is a property,
and calling it raised "'bool' object is not callable" at sign-in. Nothing in this file replaces the client class.
"""
import base64, os, struct, sys, unittest, uuid as U
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("SNAP_API_SECRET", "test-secret")

from snapchat import SnapchatClient
import bridge as B
import server

ME = "2510ebad-9409-5ab9-bfaf-e80838f7077f"
CONV = "6e609ac8-04ed-45b8-9dee-002cdaf13db5"
OTHER = str(U.uuid5(U.NAMESPACE_DNS, "friend"))


def ld(tag, payload):
    n = len(payload); v = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        v.append(b | (0x80 if n else 0))
        if not n: break
    return bytes([tag]) + bytes(v) + payload


def message_record(conv, text, mine=False, my=ME):
    """One message shaped like the one send_text builds, preceded by the conversation reference."""
    body = b"\x0a\x12\x0a\x10" + U.UUID(conv).bytes
    if mine:
        body += b"\x1a\x18\x0a\x16\x0a\x12\x0a\x10" + U.UUID(my).bytes + b"\x10\x29"
    content = bytes([0x10, 0x01]) + ld(0x22, ld(0x12, ld(0x0A, text.encode()))) + bytes([0x38, 0x02])
    return body + ld(0x22, content)


class FakeResp:
    def __init__(self, payload=b"", grpc_status="0", cookies=None, status=200):
        trailer = f"grpc-status:{grpc_status}\r\n".encode()
        self.content = (struct.pack("!BI", 0, len(payload)) + payload if payload else b"") + struct.pack("!BI", 0x80, len(trailer)) + trailer
        self.status_code, self.headers, self.cookies, self.text = status, {"grpc-status": grpc_status}, cookies or {}, ""


class Net:
    """The fake network shared by every NetClient in a test."""
    def __init__(self):
        self.login_replies, self.sync_payload, self.sent, self.posts = [], b"", [], []
        self.token = base64.urlsafe_b64encode(b"\x0a\x10" + U.UUID(ME).bytes + b"\xff" * 220).decode().rstrip("=")


def make_client_class(net):
    class NetClient(SnapchatClient):
        def _grpc_post(self, url, protobuf, cookies=None, origin="", timeout=30):
            net.posts.append((url, protobuf, dict(cookies or {})))
            return net.login_replies.pop(0)

        def _grpc_call(self, url, protobuf, timeout=30):
            if url.endswith("/DeltaSync"):
                if bytes.fromhex(ME.replace("-", "")) not in protobuf:
                    return FakeResp(grpc_status="7")
                return FakeResp(net.sync_payload)
            if url.endswith("/CreateContentMessage"):
                net.sent.append(protobuf)
                return FakeResp()
            return FakeResp(grpc_status="12")

        def refresh_bearer(self):
            self.bearer_token = net.token
            return net.token
    return NetClient


class FakeSession:
    def __init__(self):
        self.headers = {}
        self.cookies = {"sc-a-nonce": "n1"}
    def get(self, *a, **k):
        return mock.Mock(status_code=200)


class RealClientThroughRoutes(unittest.TestCase):
    def setUp(self):
        self.net = Net()
        self.net.login_replies = [
            FakeResp(bytes([0x08, 0x0D, 0x12, 0x05]) + b"chall", cookies={"a1": "x"}),   # email step: status 13 then challenge
            FakeResp(b"", cookies={"sc-auth": "tok"}),                                       # password step
        ]
        server.bridge = B.Bridge(client_factory=make_client_class(self.net), answer_all=True)
        self.patch = mock.patch("curl_cffi.requests.Session", FakeSession)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()

    def test_sign_in_through_the_http_route_does_not_crash_and_finds_the_account_id(self):
        self.net.sync_payload = message_record(CONV, "hi") + b"\x00" * 40
        code, out = server.route("POST", "/login", {"username": "Ari@gmail.com", "password": "pw-123"}, "")
        self.assertEqual(code, 200)
        self.assertTrue(out["signed_in"])
        self.assertEqual(out["user_uuid_found"], ME)
        self.assertTrue(out["connected"])
        # the challenge was sent back, with the password, and every cookie Snapchat set was kept
        step2 = self.net.posts[1][1]
        self.assertIn(b"chall", step2); self.assertIn(b"pw-123", step2)
        self.assertEqual(set(server.bridge.client.cookies), {"sc-a-nonce", "a1", "sc-auth"})

    def test_status_before_and_after_sign_in(self):
        code, st = server.route("GET", "/status", {}, "")
        self.assertEqual((code, st["signed_in"], st["connected"]), (200, False, False))
        server.route("POST", "/login", {"username": "u", "password": "p", "user_uuid": ME}, "")
        code, st = server.route("GET", "/status", {}, "")
        self.assertEqual((code, st["signed_in"], st["connected"], st["user_uuid"]), (200, True, True, ME))

    def test_sign_in_without_a_findable_id_still_succeeds_and_says_so(self):
        self.net.token = base64.urlsafe_b64encode(b"nothing useful here" * 12).decode()
        code, out = server.route("POST", "/login", {"username": "u", "password": "p"}, "")
        self.assertEqual(code, 200)
        self.assertTrue(out["signed_in"]); self.assertFalse(out["user_uuid_set"]); self.assertIsNone(out["user_uuid_found"])

    def test_a_refused_sign_in_reports_snapchats_own_answer_and_never_a_web_page(self):
        from snapchat import AuthError
        Base = make_client_class(self.net)
        class Refused(Base):
            def refresh_bearer(self):
                raise AuthError("Snapchat answered the token request with a web page instead of a token: <!DOCTYPE html><html><body>Sign in to Snapchat</body></html>")
        self.net.login_replies[1] = FakeResp(bytes([0x08, 0x04]) + b"\x12\x0cCaptcha needed")   # status 4 plus a readable hint
        server.bridge = B.Bridge(client_factory=Refused, answer_all=True)
        with self.assertRaises(AuthError) as cm:
            server.route("POST", "/login", {"username": "u", "password": "p"}, "")
        msg = str(cm.exception)
        self.assertNotIn("<", msg); self.assertNotIn(">", msg)
        self.assertIn("code 4", msg)
        self.assertIn("Captcha needed", msg)
        self.assertIn("captcha", msg.lower())

    def test_pasted_session_route(self):
        code, out = server.route("POST", "/session", {"cookies": [{"name": "a", "value": "b"}], "user_uuid": ME}, "")
        self.assertEqual(code, 200)
        self.assertTrue(out["connected"])

    def test_real_message_reading_diagnose_and_polling(self):
        server.route("POST", "/login", {"username": "u", "password": "p", "user_uuid": ME}, "")
        self.net.sync_payload = (message_record(CONV, "hello") + message_record(CONV, "hello")
                                 + message_record(CONV, "my answer", mine=True) + message_record(CONV, "ok"))
        msgs = server.bridge.client.get_messages(CONV, 50, self.net.sync_payload)
        texts = [(m["text"], m["sender"]) for m in msgs]
        self.assertIn(("ok", "other"), texts)                        # one short word is a message
        self.assertEqual([t for t, _ in texts].count("hello"), 2)    # repeated texts are kept, not collapsed
        code, d = server.route("GET", "/diagnose", {}, "")
        self.assertEqual(code, 200)
        self.assertEqual(d["chats_found"], 1)
        self.assertEqual(d["chats"][0]["id"], CONV)
        # first look is history; a new one-word message afterwards is delivered
        got = []
        server.bridge.on_inbound = lambda c, t: got.append((c, t))
        server.bridge.poll_once()
        self.net.sync_payload += message_record(CONV, "yo")
        server.bridge.poll_once()
        self.assertEqual([t for _, t in got][-1].split("\n")[-1], "yo")

    def test_sending_goes_out_through_the_real_encoder_with_the_configured_account(self):
        server.route("POST", "/login", {"username": "u", "password": "p", "user_uuid": ME}, "")
        code, out = server.route("POST", "/send-text", {"conversation_id": CONV, "text": "x" * 300 + " caf\u00e9"}, "")
        self.assertEqual((code, out["status"]), (200, "ok"))
        self.assertIn(bytes.fromhex(ME.replace("-", "")), self.net.sent[0])

    def test_every_client_method_the_bridge_and_routes_touch_exists_with_the_expected_shape(self):
        c = SnapchatClient(cookies={"a": "b"}, bearer_token="t", my_uuid=ME)
        self.assertIsInstance(SnapchatClient.is_authenticated, property)
        for name in ("login", "refresh_bearer", "send_text", "send_media", "delta_sync", "get_messages", "sync_friends",
                     "incoming_friend_requests", "add_friend", "lookup_user", "get_stories_feed", "get_spotlight_feed", "download_media"):
            self.assertTrue(callable(getattr(c, name)), name)
        self.assertTrue(c.is_authenticated)


if __name__ == "__main__":
    unittest.main()
