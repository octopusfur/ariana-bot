"""Service tests — no network: instagrapi's Client is replaced by a fake."""
import os
import sys
import types
import unittest
from datetime import datetime
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.update({
    "IG_SERVICE_API_KEY": "k" * 32,
    "IG_HUMAN_PAUSES": "0",
    "IG_MIN_GAP_S": "0",
    "IG_MAX_GAP_S": "0",
})

import app as svc  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from instagrapi import exceptions as ex  # noqa: E402

KEY = {"X-Api-Key": "k" * 32}


class FakeClient:
    def __init__(self):
        self.username = "ariana.test"
        self.calls = []
        self.raise_on = None
        self.inbound = True

    def _hit(self, name, *a, **k):
        self.calls.append((name, a, k))
        if self.raise_on and self.raise_on[0] == name:
            raise self.raise_on[1]

    def account_info(self):
        return types.SimpleNamespace(username=self.username)

    def user_info_by_username_v1(self, u):
        self._hit("user_info", u)
        return types.SimpleNamespace(pk=42, username=u, full_name="Some One", biography="bio", follower_count=10,
                                     following_count=5, media_count=3, is_private=(u == "private.one"), is_verified=False)

    def user_medias_v1(self, pk, amount=5):
        self._hit("medias", pk, amount)
        return [types.SimpleNamespace(code="AbCdE12345", caption_text="hello", like_count=3, comment_count=1,
                                      taken_at=datetime(2026, 1, 2, 3, 4, 5))]

    def media_pk_from_code(self, code):
        return 777

    def media_info_v1(self, pk):
        self._hit("media_info", pk)
        return types.SimpleNamespace(id="777_42", code="AbCdE12345")

    def media_like(self, mid):
        self._hit("like", mid)
        return True

    def media_comment(self, mid, text):
        self._hit("comment", mid, text)
        return types.SimpleNamespace(pk=99)

    def user_follow(self, pk):
        self._hit("follow", pk)
        return True

    def user_unfollow(self, pk):
        self._hit("unfollow", pk)
        return True

    def direct_send(self, text, user_ids=None):
        self._hit("dm", text, user_ids)

    def direct_threads(self, amount=10):
        msg = types.SimpleNamespace(id="m1", text="hi", user_id=(42 if self.inbound else 1), is_sent_by_viewer=not self.inbound, timestamp=datetime(2026, 1, 1), item_type="text")
        return [types.SimpleNamespace(id=5, is_group=False, users=[types.SimpleNamespace(pk=42, username="some.one")], messages=[msg])]

    def direct_pending_inbox(self, amount=10):
        return []

    def photo_upload(self, path, caption):
        self._hit("photo_upload", str(path), caption)
        return types.SimpleNamespace(code="NewPost123")

    def get_timeline_feed(self):
        return {"feed_items": [{"media_or_ad": {"code": "ZZZZZ11111", "user": {"username": "u"}, "caption": {"text": "c"}}}]}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        svc.S.reset()
        self.fake = FakeClient()
        svc.S.client = self.fake
        svc.S.session_hash = svc._session_hash(None)
        self.http = TestClient(svc.app)

    def act(self, action, payload, handle="ariana.test"):
        return self.http.post(f"/act/{action}", json={"handle": handle, "payload": payload}, headers=KEY).json()

    def test_auth_required(self):
        self.assertEqual(self.http.post("/act/like", json={"payload": {}}).status_code, 401)
        self.assertEqual(self.http.post("/act/like", json={"payload": {}}, headers={"X-Api-Key": "nope"}).status_code, 401)
        self.assertEqual(self.http.get("/health").status_code, 401)
        self.assertEqual(self.http.get("/ping").status_code, 200)

    def test_bad_input_never_reaches_instagram(self):
        r = self.act("like", {"url": "https://example.com/x"})
        self.assertEqual((r["success"], r["code"]), (False, "bad_target"))
        r = self.act("follow", {"username": "bad name!"})
        self.assertEqual(r["code"], "bad_target")
        r = self.act("comment", {"url": "https://www.instagram.com/p/AbCdE12345/", "text": "  "})
        self.assertEqual(r["code"], "bad_target")
        self.assertEqual(self.fake.calls, [])

    def test_unknown_action(self):
        self.assertEqual(self.act("repost", {"url": "x"})["code"], "unsupported")

    def test_dm_only_replies_never_starts(self):
        r = self.act("dm", {"username": "some.one", "message": "hey you"})
        self.assertTrue(r["success"])
        self.fake.inbound = False
        self.fake.calls.clear()
        r = self.act("dm", {"username": "some.one", "message": "hello?"})
        self.assertEqual((r["success"], r["code"]), (False, "no_first_dm"))
        self.assertNotIn("dm", [c[0] for c in self.fake.calls])

    def test_post_needs_a_picture_and_never_hits_instagram_without_one(self):
        r = self.act("post", {"text": "hello"})
        self.assertEqual(r["code"], "bad_target")
        r = self.act("post", {"text": "x", "image_url": "http://insecure.example/a.jpg"})
        self.assertEqual(r["code"], "bad_target")
        r = self.act("post", {"text": "x", "image_url": "https://127.0.0.1/a.jpg"})
        self.assertEqual(r["code"], "bad_target")
        self.assertEqual(self.fake.calls, [])

    def test_post_uploads_a_jpeg(self):
        with mock.patch("app.fetch_image_as_jpeg", return_value="/tmp/none.jpg"):
            r = self.act("post", {"text": "new pic", "image_url": "https://example.com/a.jpg"})
        self.assertTrue(r["success"])
        self.assertEqual(r["data"]["url"], "https://www.instagram.com/p/NewPost123/")

    def test_session_is_taken_from_the_request(self):
        built = []
        def fake_build(session=None, handle=None):
            built.append((session, handle)); return self.fake
        with mock.patch("app.build_client", side_effect=fake_build):
            svc.S.session_hash = None
            body = {"handle": "ariana.test", "payload": {"username": "some.one"}, "session": {"settings": {"a": 1}}}
            self.http.post("/act/view_profile", json=body, headers=KEY)
            self.http.post("/act/view_profile", json=body, headers=KEY)   # same session: not rebuilt
            body["session"] = {"settings": {"a": 2}}
            self.http.post("/act/view_profile", json=body, headers=KEY)   # new session: rebuilt
        self.assertEqual(len(built), 2)

    def test_no_session_is_a_clear_message(self):
        svc.S.client = None; svc.S.session_hash = None
        r = self.act("view_profile", {"username": "some.one"})
        self.assertEqual(r["code"], "no_session")

    def test_inbox_lists_who_wrote(self):
        r = self.http.post("/inbox", json={"handle": "ariana.test"}, headers=KEY).json()
        self.assertTrue(r["success"])
        t = r["threads"][0]
        self.assertEqual((t["username"], t["messages"][0]["from_them"]), ("some.one", True))

    def test_login_never_echoes_the_password_and_maps_errors(self):
        class L:
            def login(self, u, p, verification_code=""): raise ex.TwoFactorRequired()
        with mock.patch("app.new_client", return_value=L()):
            svc.S.last_login = 0
            r = self.http.post("/login", json={"username": "ariana.test", "password": "pw-secret"}, headers=KEY).json()
        self.assertEqual(r["code"], "two_factor")
        self.assertNotIn("pw-secret", str(r))
        class OK:
            username = "ariana.test"
            def login(self, u, p, verification_code=""): return True
            def get_settings(self): return {"cookies": {"sessionid": "x"}}
        with mock.patch("app.new_client", return_value=OK()):
            svc.S.last_login = 0
            r = self.http.post("/login", json={"username": "ariana.test", "password": "pw", "code": "123456"}, headers=KEY).json()
        self.assertTrue(r["connected"]); self.assertIn("cookies", r["settings"])

    def test_like_looks_then_acts(self):
        r = self.act("like", {"url": "https://www.instagram.com/reel/AbCdE12345/?igsh=1"})
        self.assertTrue(r["success"])
        self.assertEqual([c[0] for c in self.fake.calls], ["media_info", "like"])

    def test_follow_looks_up_profile_first(self):
        r = self.act("follow", {"username": "@some.one"})
        self.assertTrue(r["success"])
        self.assertEqual([c[0] for c in self.fake.calls], ["user_info", "follow"])

    def test_profile_and_posts(self):
        p = self.act("view_profile", {"username": "some.one"})["data"]
        self.assertEqual((p["followers"], p["is_private"]), (10, False))
        posts = self.act("view_posts", {"username": "some.one"})["data"]["posts"]
        self.assertEqual(posts[0]["url"], "https://www.instagram.com/p/AbCdE12345/")
        self.assertEqual(self.act("view_posts", {"username": "private.one"})["code"], "private_account")

    def test_wrong_account_stops_everything(self):  # handle must match the signed-in account
        r = self.act("like", {"url": "https://www.instagram.com/p/AbCdE12345/"}, handle="someone.else")
        self.assertEqual(r["code"], "wrong_account")
        self.assertEqual(self.fake.calls, [])

    def test_daily_cap(self):
        with mock.patch.dict(os.environ, {"IG_DAILY_LIKES": "2"}):
            url = {"url": "https://www.instagram.com/p/AbCdE12345/"}
            self.assertTrue(self.act("like", url)["success"])
            self.assertTrue(self.act("like", url)["success"])
            r = self.act("like", url)
            self.assertEqual(r["code"], "daily_cap")

    def test_pushback_pauses_writes_but_not_reads(self):
        self.fake.raise_on = ("like", ex.FeedbackRequired())
        url = {"url": "https://www.instagram.com/p/AbCdE12345/"}
        self.assertEqual(self.act("like", url)["code"], "action_blocked")
        self.fake.raise_on = None
        self.assertEqual(self.act("like", url)["code"], "cooldown")
        self.assertEqual(self.act("follow", {"username": "some.one"})["code"], "cooldown")
        self.assertTrue(self.act("view_profile", {"username": "some.one"})["success"])

    def test_challenge_drops_session(self):
        self.fake.raise_on = ("user_info", ex.ChallengeRequired())
        self.assertEqual(self.act("view_profile", {"username": "some.one"})["code"], "challenge")
        self.assertIsNone(svc.S.client)

    def test_login_required_maps_to_session_expired_without_cooldown(self):
        self.fake.raise_on = ("user_info", ex.LoginRequired())
        self.assertEqual(self.act("view_profile", {"username": "some.one"})["code"], "session_expired")
        self.assertEqual(svc.S.cooldown_until, 0.0)

    def test_quiet_hours(self):
        with mock.patch.dict(os.environ, {"IG_ACTIVE_HOURS": "9-10", "IG_UTC_OFFSET_MIN": "0"}):
            with mock.patch("app.time.time", return_value=3 * 3600.0):
                r = self.act("like", {"url": "https://www.instagram.com/p/AbCdE12345/"})
        self.assertEqual(r["code"], "quiet_hours")

    def test_verify(self):
        ok = self.http.post("/verify", json={"handle": "ariana.test"}, headers=KEY).json()
        self.assertTrue(ok["connected"])
        bad = self.http.post("/verify", json={"handle": "other"}, headers=KEY).json()
        self.assertFalse(bad["connected"])

    def test_seeded_device_is_stable(self):
        a, b = svc.seeded_uuids("x"), svc.seeded_uuids("x")
        self.assertEqual(a, b)
        self.assertNotEqual(a, svc.seeded_uuids("y"))

    def test_boot_requires_env(self):
        with mock.patch.dict(os.environ, {"IG_SERVICE_API_KEY": "short"}):
            with self.assertRaises(RuntimeError):
                svc.require_env()


if __name__ == "__main__":
    unittest.main()
