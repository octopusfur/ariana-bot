import os, sys, unittest, uuid as U
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("SNAP_API_SECRET", "test-secret")

from snapchat import SnapchatClient, SnapchatError, AuthError
from snapchat.client import _read_varint, _parse_login_challenge
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
        self.messages_by_conv, self.sync_blob = {}, b""
    @property
    def is_authenticated(self): return bool(self.cookies) and bool(self.bearer_token)
    def refresh_bearer(self): self.refreshed += 1; self.bearer_token = "tok"; return "tok"
    def send_text(self, conv, text): self.sent.append((conv, text)); return {"status": "ok"}
    def delta_sync(self): return self.sync_blob
    def get_messages(self, conv, limit=50, data=None): return list(self.messages_by_conv.get(conv, self.messages))


def make_bridge(**kw):
    kw.setdefault("answer_all", False)  # the classic tests use an explicit chat list
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
        # the old message nobody answered goes along with the new one
        self.assertEqual([m["text"] for m in b.poll_once()], ["old one\nbrand new"])
        self.assertEqual(b.poll_once(), [])           # not delivered twice
        self.assertEqual(got, [(CONV, "old one\nbrand new")])

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


def conv_frame(u):
    return b"\x0a\x12\x0a\x10" + U.UUID(u).bytes


CONV2 = str(U.uuid5(U.NAMESPACE_DNS, "second chat"))
CONV3 = str(U.uuid5(U.NAMESPACE_DNS, "third chat"))


class LoginParse(unittest.TestCase):
    def test_reads_challenge_after_status_13(self):
        # the real shape that broke upstream: field 1 = 13 ("send the password"), then field 2 = challenge
        status, challenge = _parse_login_challenge(bytes([0x08, 0x0D, 0x12, 0x05]) + b"hello")
        self.assertEqual((status, challenge), (13, b"hello"))

    def test_no_challenge_returns_none(self):
        self.assertEqual(_parse_login_challenge(bytes([0x08, 0x02])), (2, None))


class AnswerEveryone(unittest.TestCase):
    def make(self):
        got = []
        b = B.Bridge(my_uuid=ME, conversations=[], client_factory=FakeClient, answer_all=True, on_inbound=lambda c, t: got.append((c, t)))
        b.load_session({"a": "b"}, "tok")
        return b, got

    def test_finds_chat_ids_without_a_list(self):
        raw = conv_frame(CONV2) + conv_frame(ME) + b"\x00" + conv_frame(CONV3)
        self.assertEqual(B.extract_conversation_ids(raw, exclude=[ME]), [CONV2, CONV3])

    def test_answers_chats_it_was_never_told_about_but_not_old_history(self):
        b, got = self.make()
        c = b.client
        c.sync_blob = conv_frame(CONV2)
        c.messages_by_conv = {CONV2: [{"text": "old history", "sender": "other"}]}
        self.assertEqual(b.poll_once(), [])                       # first pass: history only
        c.messages_by_conv[CONV2] = [{"text": "hello ariana", "sender": "other"}, {"text": "old history", "sender": "other"}]
        # the unanswered old message is answered together with the new one, like a person would
        self.assertEqual([m["text"] for m in b.poll_once()], ["old history\nhello ariana"])
        self.assertEqual(got, [(CONV2, "old history\nhello ariana")])

    def test_old_messages_she_or_the_owner_already_answered_are_not_repeated(self):
        b, got = self.make()
        c = b.client
        c.sync_blob = conv_frame(CONV2)
        c.messages_by_conv = {CONV2: [{"text": "an answer", "sender": "me"}, {"text": "old question", "sender": "other"}]}
        b.poll_once()
        c.messages_by_conv[CONV2] = [{"text": "next one", "sender": "other"}] + c.messages_by_conv[CONV2]
        self.assertEqual([m["text"] for m in b.poll_once()], ["next one"])

    def test_the_same_text_again_is_a_new_message(self):
        b, got = self.make()
        c = b.client
        c.sync_blob = conv_frame(CONV2)
        c.messages_by_conv = {CONV2: [{"text": "hi", "sender": "other"}]}
        b.poll_once()                                           # baseline: "hi" is old and unanswered
        c.messages_by_conv[CONV2] = [{"text": "hi", "sender": "other"}, {"text": "hi", "sender": "other"}]
        self.assertEqual([m["text"] for m in b.poll_once()], ["hi\nhi"])
        self.assertEqual(b.poll_once(), [])                     # and not delivered twice

    def test_two_messages_in_one_look_become_one_reply_turn(self):
        b, got = self.make()
        c = b.client
        c.sync_blob = conv_frame(CONV2); c.messages_by_conv = {CONV2: []}
        b.poll_once()
        c.messages_by_conv[CONV2] = [{"text": "are you there", "sender": "other"}, {"text": "hello", "sender": "other"}]
        self.assertEqual([m["text"] for m in b.poll_once()], ["hello\nare you there"])
        self.assertEqual(len(got), 1)

    def test_a_brand_new_chat_after_start_is_answered(self):
        b, got = self.make()
        c = b.client
        c.sync_blob = conv_frame(CONV2); c.messages_by_conv = {CONV2: []}
        b.poll_once()
        c.sync_blob = conv_frame(CONV2) + conv_frame(CONV3)       # a new friend writes for the first time
        c.messages_by_conv[CONV3] = [{"text": "hi it is me", "sender": "other"}]
        self.assertEqual([m["text"] for m in b.poll_once()], ["hi it is me"])

    def test_her_own_replies_are_not_answered(self):
        b, got = self.make()
        c = b.client
        c.sync_blob = conv_frame(CONV2); c.messages_by_conv = {CONV2: []}
        b.poll_once()
        b.send_text(CONV2, "my reply")
        c.messages_by_conv[CONV2] = [{"text": "my reply", "sender": "other"}]
        self.assertEqual(b.poll_once(), [])

    def test_list_only_mode_ignores_discovered_chats(self):
        b = B.Bridge(my_uuid=ME, conversations=[], client_factory=FakeClient, answer_all=False)
        b.load_session({"a": "b"}, "tok")
        b.client.sync_blob = conv_frame(CONV2)
        b.client.messages_by_conv = {CONV2: [{"text": "hello there", "sender": "other"}]}
        self.assertEqual(b.poll_once(), [])
        b.client.messages_by_conv = {CONV2: [{"text": "hello there again", "sender": "other"}]}
        self.assertEqual(b.poll_once(), [])


class DiscoverAccountId(unittest.TestCase):
    def test_token_candidates_include_uuid_text_and_framed_bytes(self):
        import base64
        raw = b"\x08\x01\x0a\x10" + U.UUID(ME).bytes + b"\xff" * 8
        tok = base64.urlsafe_b64encode(raw).decode().rstrip("=")
        self.assertIn(ME, B.user_id_candidates(tok))
        self.assertIn(ME, B.user_id_candidates("prefix-" + ME + "-suffix"))

    def test_only_an_id_that_makes_a_real_sync_succeed_is_accepted(self):
        import base64
        wrong = str(U.uuid5(U.NAMESPACE_DNS, "not me"))
        raw = b"\x0a\x10" + U.UUID(wrong).bytes + b"\x0a\x10" + U.UUID(ME).bytes
        tok = base64.urlsafe_b64encode(raw).decode()
        class Picky(FakeClient):
            def delta_sync(self):
                if self.MY_UUID != U.UUID(ME).bytes: raise SnapchatError("grpc-status=7")
                return b"x" * 64
        b = B.Bridge(my_uuid="", conversations=[], client_factory=Picky)
        b.load_session({"a": "b"}, tok)
        self.assertEqual(b.discover_user_uuid(), ME)
        self.assertEqual(b.my_uuid, ME)

    def test_returns_none_and_changes_nothing_when_nothing_works(self):
        class Nope(FakeClient):
            def delta_sync(self): raise SnapchatError("denied")
        b = B.Bridge(my_uuid="", conversations=[], client_factory=Nope)
        b.load_session({"a": "b"}, "prefix-" + ME)
        self.assertIsNone(b.discover_user_uuid())
        self.assertEqual(b.my_uuid, "")


class Alignment(unittest.TestCase):
    def test_cases(self):
        n = B.new_since
        self.assertEqual(n(["a", "b"], ["a", "b"]), [])
        self.assertEqual(n(["a", "b"], ["x", "a", "b"]), ["x"])
        self.assertEqual(n(["a"], ["a", "a"]), ["a"])               # same text again
        self.assertEqual(n(["a", "a"], ["a", "a"]), [])
        self.assertEqual(n(["a", "a"], ["a", "a", "a"]), ["a"])
        self.assertEqual(n(["a", "b", "c"], ["x", "y", "a", "b", "c"]), ["x", "y"])
        self.assertEqual(n([], ["x", "y", "z", "w"]), ["x", "y", "z"])   # a new chat: newest 3
        self.assertEqual(n(["a"], ["q", "r"]), ["q", "r"])               # old window scrolled out


if __name__ == "__main__":
    unittest.main()
