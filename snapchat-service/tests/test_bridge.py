import os, sys, unittest, uuid as U
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("SNAP_API_SECRET", "test-secret")

from snapchat import SnapchatClient, SnapchatError, AuthError
from snapchat.client import _read_varint
import bridge as B

ME = "2510ebad-9409-5ab9-bfaf-e80838f7077f"
CONV = "6e609ac8-04ed-45b8-9dee-002cdaf13db5"


def parse_text(proto):
    """Walk the send_text proto down to the text bytes."""
    def fields(buf):
        pos, out = 0, []
        while pos < len(buf):
            tag = buf[pos]; pos += 1
            wt = tag & 7
            if wt == 0:
                _, pos = _read_varint(buf, pos)
            elif wt == 2:
                n, pos = _read_varint(buf, pos)
                out.append((tag >> 3, buf[pos:pos + n])); pos += n
            else:
                raise ValueError("unexpected wire type")
        return out
    f4 = dict(fields(proto))[4]
    inner4 = dict(fields(f4))[4]
    msg = dict(fields(inner4))[2]
    return dict(fields(msg))[1]


class FakeClient:
    """Stands in for SnapchatClient; records calls and returns scripted messages."""
    def __init__(self, cookies=None, bearer_token="", my_uuid=""):
        self.cookies, self.bearer_token, self.MY_UUID = cookies or {}, bearer_token, my_uuid
        self.sent, self.messages, self.refreshed = [], [], 0
    def is_authenticated(self): return bool(self.cookies) and bool(self.bearer_token)
    def refresh_bearer(self): self.refreshed += 1; self.bearer_token = "tok"; return "tok"
    def send_text(self, conv, text): self.sent.append((conv, text)); return {"status": "ok"}
    def get_messages(self, conv, limit=50): return list(self.messages)


def make_bridge(**kw):
    b = B.Bridge(my_uuid=ME, conversations=[CONV], client_factory=FakeClient, **kw)
    b.load_session({"a": "b"}, "tok")
    return b


class SendTextProto(unittest.TestCase):
    def build(self, text):
        c = SnapchatClient(cookies={"a": "b"}, bearer_token="t", my_uuid=ME)
        cap = {}
        class R:  # minimal response
            status_code = 200; headers = {"grpc-status": "0"}; content = b"\x00\x00\x00\x00\x00grpc-status:0"
        c._grpc_call = lambda url, body, *a, **k: (cap.setdefault("body", body), R())[1]
        c.send_text(CONV, text)
        return cap["body"]

    def test_short_ascii(self):
        self.assertEqual(parse_text(self.build("hey you")), b"hey you")

    def test_long_text_over_127_bytes(self):
        t = "x" * 400
        self.assertEqual(parse_text(self.build(t)), t.encode())

    def test_unicode_uses_byte_length(self):
        t = "caf\u00e9 \u2728 " * 30
        self.assertEqual(parse_text(self.build(t)), t.encode("utf-8"))

    def test_sender_is_the_configured_account_not_the_upstream_author(self):
        body = self.build("hi")
        self.assertIn(bytes.fromhex(ME.replace("-", "")), body)
        self.assertNotEqual(SnapchatClient.MY_UUID, bytes.fromhex(ME.replace("-", "")))
        self.assertEqual(SnapchatClient.MY_UUID, b"")


class Candidates(unittest.TestCase):
    def test_finds_v5_ids_and_skips_own_and_junk(self):
        other = U.uuid5(U.NAMESPACE_DNS, "friend")
        mine = U.UUID(ME)
        junk = bytes([0xFF] * 16)
        raw = b"\x01" + b"\x0a\x10" + other.bytes + b"\x0a\x10" + mine.bytes + b"\x0a\x10" + junk
        self.assertEqual(B.extract_uuid_candidates(raw, exclude=[ME]), [str(other)])


class Polling(unittest.TestCase):
    def test_history_is_baselined_then_only_new_other_messages_delivered(self):
        got = []
        b = make_bridge(); b.on_inbound = lambda c, t: got.append((c, t))
        b.client.messages = [{"text": "old one", "sender": "other"}]
        self.assertEqual(b.poll_once(), [])           # baseline, nothing delivered
        b.client.messages = [{"text": "brand new", "sender": "other"}, {"text": "old one", "sender": "other"}]
        self.assertEqual([m["text"] for m in b.poll_once()], ["brand new"])
        self.assertEqual(b.poll_once(), [])           # not delivered twice
        self.assertEqual(got, [(CONV, "brand new")])

    def test_own_messages_and_echoes_never_delivered(self):
        b = make_bridge()
        b.poll_once()
        b.send_text(CONV, "i said this")
        b.client.messages = [{"text": "i said this", "sender": "other"},   # misattributed echo
                             {"text": "mine", "sender": "me"}]
        self.assertEqual(b.poll_once(), [])

    def test_only_allowlisted_conversations_are_polled(self):
        b = make_bridge(); b.set_conversations(replace=[])
        b.client.messages = [{"text": "hello there", "sender": "other"}]
        self.assertEqual(b.poll_once(), [])

    def test_no_user_uuid_means_no_polling_or_sending(self):
        b = B.Bridge(my_uuid="", conversations=[CONV], client_factory=FakeClient)
        b.load_session({"a": "b"}, "tok")
        self.assertEqual(b.poll_once(), [])
        with self.assertRaises(SnapchatError): b.send_text(CONV, "hi")

    def test_expired_session_refreshes_once(self):
        b = make_bridge()
        calls = {"n": 0}
        orig = b.client.send_text
        def flaky(conv, text):
            calls["n"] += 1
            if calls["n"] == 1: raise AuthError("expired")
            return orig(conv, text)
        b.client.send_text = flaky
        self.assertEqual(b.send_text(CONV, "hi")["status"], "ok")
        self.assertEqual(b.client.refreshed, 1)


class Guards(unittest.TestCase):
    def test_send_rate_limit(self):
        b = make_bridge(max_sends_per_hour=2)
        b.send_text(CONV, "a"); b.send_text(CONV, "b")
        with self.assertRaises(SnapchatError): b.send_text(CONV, "c")

    def test_rejects_bad_conversation_id_and_empty_text(self):
        b = make_bridge()
        with self.assertRaises(SnapchatError): b.send_text("not-a-uuid", "hi")
        with self.assertRaises(SnapchatError): b.send_text(CONV, "   ")

    def test_download_only_snapchat_cdn_https(self):
        b = make_bridge()
        for bad in ("http://cf-st.sc-cdn.net/x", "https://evil.com/x", "https://sc-cdn.net.evil.com/x", "file:///etc/passwd", ""):
            with self.assertRaises(SnapchatError): b.download(bad)

    def test_unsupported_features_return_501_with_reason(self):
        import server
        for p in ("/post-story", "/like", "/comment", "/follow"):
            code, body = server.route("POST", p, {}, "")
            self.assertEqual(code, 501); self.assertIn("error", body)


if __name__ == "__main__":
    unittest.main()
