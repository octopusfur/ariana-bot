"""
Ariana's Instagram service — instagrapi behind a small authenticated HTTP API.

Why a separate service
──────────────────────
instagrapi talks to Instagram's private mobile API (the one the phone app uses),
so there is no browser here: no Chromium, no Playwright. That is what keeps it
small. It runs apart from Ariana's brain so an Instagram problem (a challenge, a
slow response, a crash) can never take her conversations down.

What "human" means here (and what it cannot mean)
─────────────────────────────────────────────────
  · One stable device identity, derived from IG_DEVICE_SEED, so a restart does
    not look like a brand-new phone every time.
  · One action at a time. Random pauses between requests, a "look first, then
    act" step (view the post before liking it, view the profile before
    following), typing time proportional to the length of a comment or DM.
  · Random gaps between write actions, daily caps per action type, optional
    active hours.
  · The moment Instagram pushes back (challenge, feedback_required, rate
    limit), every WRITE is refused for a cool-down. Pushing through is how
    accounts get restricted.
Instagram can still flag an account: a datacenter IP is the biggest risk, so set
IG_PROXY to a residential or mobile proxy. Nothing here can promise otherwise.

Idle behaviour: no timers, no polling, no keep-alive. It acts only on a request.
Counters live in memory, so a restart resets the daily caps (Ariana's own guards
keep a persistent count on her side).
"""

import base64
import hashlib
import hmac
import io
import ipaddress
import json
import logging
import os
import random
import re
import socket
import tempfile
import threading
import time
import uuid
from collections import defaultdict, deque
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import requests

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from instagrapi import Client
from instagrapi import exceptions as ex

LOG = logging.getLogger("ariana.ig_service")

MIN_KEY_LENGTH = 24
READ_ACTIONS = {"view_profile", "view_posts", "view_feed", "read_dms", "engagement"}
WRITE_ACTIONS = {"like", "comment", "follow", "unfollow", "dm", "post"}
ACTIONS = READ_ACTIONS | WRITE_ACTIONS


# ── CONFIG ──────────────────────────────────────────────────────────────────

def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


class Config:
    """Read at call time, so tests (and a changed env) take effect without a reload."""

    @property
    def api_key(self) -> str:
        return os.getenv("IG_SERVICE_API_KEY", "").strip()

    @property
    def username(self) -> str:
        return os.getenv("IG_USERNAME", "").strip().lstrip("@").lower()

    @property
    def sessionid(self) -> str:
        return os.getenv("IG_SESSIONID", "").strip()

    @property
    def settings_b64(self) -> str:
        return os.getenv("IG_SETTINGS_B64", "").strip()

    @property
    def proxy(self) -> str:
        return os.getenv("IG_PROXY", "").strip()

    @property
    def device_seed(self) -> str:
        return os.getenv("IG_DEVICE_SEED", "").strip() or self.username or "ariana"

    @property
    def caps(self) -> dict:
        return {
            "like": _int("IG_DAILY_LIKES", 60),
            "comment": _int("IG_DAILY_COMMENTS", 15),
            "follow": _int("IG_DAILY_FOLLOWS", 20),
            "unfollow": _int("IG_DAILY_UNFOLLOWS", 20),
            "dm": _int("IG_DAILY_DMS", 15),
            "post": _int("IG_DAILY_POSTS", 3),
        }

    @property
    def gap_range(self) -> tuple:
        lo = max(0, _int("IG_MIN_GAP_S", 25))
        hi = max(lo, _int("IG_MAX_GAP_S", 75))
        return lo, hi

    @property
    def cooldown_hours(self) -> float:
        return _float("IG_COOLDOWN_HOURS", 6.0)

    @property
    def active_hours(self) -> Optional[tuple]:
        raw = os.getenv("IG_ACTIVE_HOURS", "").strip()
        m = re.fullmatch(r"(\d{1,2})-(\d{1,2})", raw)
        if not m:
            return None
        a, b = int(m.group(1)), int(m.group(2))
        return (a, b) if 0 <= a <= 24 and 0 <= b <= 24 and a != b else None

    @property
    def utc_offset_min(self) -> int:
        return _int("IG_UTC_OFFSET_MIN", 0)

    @property
    def think(self) -> bool:
        return os.getenv("IG_HUMAN_PAUSES", "1").strip() != "0"


CFG = Config()


def require_env() -> None:
    """Fail at boot, naming everything wrong, never partially start.

    The Instagram login itself is NOT configured here: Ariana's dashboard signs in once and keeps the
    session in her Supabase database, then hands it to this service with each request. IG_SESSIONID /
    IG_SETTINGS_B64 / IG_USERNAME still work as an optional fallback for a single fixed account.
    """
    key = CFG.api_key
    if not key:
        raise RuntimeError("IG_SERVICE_API_KEY is missing")
    if len(key) < MIN_KEY_LENGTH:
        raise RuntimeError(f"IG_SERVICE_API_KEY must be at least {MIN_KEY_LENGTH} characters")


# ── HUMAN PACING ────────────────────────────────────────────────────────────

def pause(lo: float, hi: float) -> None:
    if CFG.think and hi > 0:
        time.sleep(random.uniform(lo, hi))


def typing_time(text: str) -> float:
    """Roughly how long a person takes to type this on a phone, jittered and capped."""
    return min(25.0, max(1.5, len(text) * random.uniform(0.12, 0.3)))


def seeded_uuids(seed: str) -> dict:
    """The same device identity every start, so a restart is not a 'new phone'."""
    ns = uuid.uuid5(uuid.NAMESPACE_URL, "ariana-ig:" + seed)

    def u(tag: str) -> str:
        return str(uuid.uuid5(ns, tag))

    return {
        "phone_id": u("phone"),
        "uuid": u("uuid"),
        "client_session_id": u("client-session"),
        "advertising_id": u("advertising"),
        "android_device_id": "android-" + u("android").replace("-", "")[:16],
        "request_id": u("request"),
        "tray_session_id": u("tray"),
    }


# ── ERRORS ──────────────────────────────────────────────────────────────────

def _classes(*names: str) -> tuple:
    return tuple(getattr(ex, n) for n in names if hasattr(ex, n))


_SESSION = _classes("LoginRequired", "ClientLoginRequired", "ClientUnauthorizedError", "BadCredentials", "ReloginAttemptExceeded")
_CHALLENGE = _classes("ChallengeRequired", "ChallengeError", "ChallengeRedirection", "ChallengeUnknownStep",
                      "ChallengeSelfieCaptcha", "CaptchaChallengeRequired", "RecaptchaChallengeForm",
                      "SelectContactPointRecoveryForm", "SubmitPhoneNumberForm", "AccountContactPointRequired")
_BLOCKED = _classes("FeedbackRequired", "SentryBlock", "AccountSuspended")
_RATE = _classes("PleaseWaitFewMinutes", "RateLimitError", "ClientThrottledError")
_NOT_FOUND = _classes("UserNotFound", "MediaNotFound", "NotFoundError", "ClientNotFoundError", "InvalidMediaId", "MediaUnavailable")
_NET = _classes("ClientConnectionError", "ClientRequestTimeout", "ClientIncompleteReadError", "ProxyAddressIsBlocked")


class ActionError(Exception):
    def __init__(self, code: str, error: str, cooldown_hours: float = 0.0):
        super().__init__(error)
        self.code, self.error, self.cooldown_hours = code, error, cooldown_hours


def classify(e: Exception) -> ActionError:
    """Turns whatever instagrapi raised into a code Ariana can speak about honestly."""
    if isinstance(e, ActionError):
        return e
    cd = CFG.cooldown_hours
    if _CHALLENGE and isinstance(e, _CHALLENGE):
        return ActionError("challenge", "Instagram is asking for a security check (challenge). Open the account in the Instagram app, "
                           "approve it, then refresh the session on this service. Actions are paused meanwhile.", cd)
    if _BLOCKED and isinstance(e, _BLOCKED):
        return ActionError("action_blocked", "Instagram has restricted this action on the account (feedback_required). "
                           "Actions are paused so it is not pushed further.", cd)
    if _RATE and isinstance(e, _RATE):
        return ActionError("rate_limited", "Instagram is rate limiting the account. Actions are paused for a while.", min(cd, 1.0))
    if _SESSION and isinstance(e, _SESSION):
        return ActionError("session_expired", "Instagram no longer accepts the saved session. Refresh IG_SESSIONID on this service.", 0.0)
    if hasattr(ex, "PrivateAccount") and isinstance(e, ex.PrivateAccount):
        return ActionError("private_account", "That account is private and Ariana does not follow it.")
    if hasattr(ex, "CommentsDisabled") and isinstance(e, ex.CommentsDisabled):
        return ActionError("comments_disabled", "Comments are turned off on that post.")
    if hasattr(ex, "DirectMessageRequestsDisabled") and isinstance(e, ex.DirectMessageRequestsDisabled):
        return ActionError("dm_blocked", "That person does not accept message requests.")
    if _NOT_FOUND and isinstance(e, _NOT_FOUND):
        return ActionError("not_found", "Instagram could not find that.")
    if _NET and isinstance(e, _NET):
        return ActionError("unreachable", f"Could not reach Instagram ({type(e).__name__}). If this repeats, check IG_PROXY.")
    return ActionError("ig_error", (str(e) or type(e).__name__)[:300])


# ── STATE ───────────────────────────────────────────────────────────────────

class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()          # one Instagram action at a time
        self.client: Optional[Client] = None
        self.identity: Optional[str] = None   # username the session really is
        self.session_hash: Optional[str] = None
        self.last_write = 0.0
        self.last_login = 0.0
        self.cooldown_until = 0.0
        self.cooldown_code = ""
        self.sent: dict = defaultdict(deque)  # action -> timestamps (24h window)
        self.pks: dict = {}                   # username -> pk

    def reset(self) -> None:
        self.__init__()


S = State()


def _day_count(action: str) -> int:
    q = S.sent[action]
    cutoff = time.time() - 86400
    while q and q[0] < cutoff:
        q.popleft()
    return len(q)


def new_client(seed: str) -> Client:
    """A client with this service's pacing, proxy, locale and the stable device identity for `seed`."""
    cl = Client()
    # instagrapi sleeps a random interval before every private request.
    cl.delay_range = [1, 3] if CFG.think else None
    if CFG.proxy:
        cl.set_proxy(CFG.proxy)
    cl.set_uuids(seeded_uuids(seed))
    cl.set_country(os.getenv("IG_COUNTRY", "US").strip() or "US")
    cl.set_locale(os.getenv("IG_LOCALE", "en_US").strip() or "en_US")
    cl.set_timezone_offset(CFG.utc_offset_min * 60)
    return cl


def build_client(session: Optional[dict] = None, handle: Optional[str] = None) -> Client:
    """From the session Ariana sends ({"settings": {...}} or {"sessionid": "..."}), else the env fallback."""
    session = session or {}
    settings = session.get("settings")
    sessionid = (session.get("sessionid") or "").strip()
    if not settings and not sessionid:
        if CFG.settings_b64:
            try:
                settings = json.loads(base64.b64decode(CFG.settings_b64).decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                raise ActionError("bad_config", f"IG_SETTINGS_B64 could not be read ({type(e).__name__}).")
        else:
            sessionid = CFG.sessionid
    if not settings and not sessionid:
        raise ActionError("no_session", "No Instagram session yet. Open Settings in the dashboard and connect the account.")
    seed = CFG.device_seed if (CFG.sessionid or CFG.settings_b64) and not session else (handle or CFG.username or "ariana")
    cl = new_client(seed)
    if settings:
        uu = (settings.get("uuids") or {})
        cl.set_settings(settings)
        if CFG.proxy:
            cl.set_proxy(CFG.proxy)
        cl.delay_range = [1, 3] if CFG.think else None
        if not uu:
            cl.set_uuids(seeded_uuids(seed))
    else:
        cl.login_by_sessionid(sessionid)
    return cl


def _session_hash(session: Optional[dict]) -> str:
    return hashlib.sha256(json.dumps(session or {}, sort_keys=True, default=str).encode()).hexdigest()


def get_client(session: Optional[dict] = None, handle: Optional[str] = None) -> Client:
    h = _session_hash(session)
    if S.client is None or S.session_hash != h:
        S.client = build_client(session, handle)
        S.session_hash = h
        S.identity = None
        S.pks = {}
    return S.client


def whoami(cl: Client, fresh: bool = False) -> str:
    if S.identity and not fresh:
        return S.identity
    name = (getattr(cl, "username", None) or "").lower()
    if fresh or not name:
        name = (cl.account_info().username or "").lower()
    S.identity = name
    return name


# ── GUARDS ──────────────────────────────────────────────────────────────────

def check_account(cl: Client, handle: Optional[str]) -> None:
    """Never act as an account other than the one Ariana named."""
    me = whoami(cl)
    wanted = (handle or "").lstrip("@").lower() or CFG.username
    if wanted and me and me != wanted:
        raise ActionError("wrong_account", f"This session is signed in as @{me}, not @{wanted}. Reconnect the right account in Settings.")


def check_write_allowed(action: str) -> None:
    now = time.time()
    if now < S.cooldown_until:
        mins = int((S.cooldown_until - now) / 60) + 1
        raise ActionError("cooldown", f"Instagram pushed back earlier ({S.cooldown_code}); writes are paused for about {mins} more minute(s) to protect the account.")
    window = CFG.active_hours
    if window:
        local_h = ((now / 3600) + CFG.utc_offset_min / 60) % 24
        a, b = window
        inside = (a <= local_h < b) if a < b else (local_h >= a or local_h < b)
        if not inside:
            raise ActionError("quiet_hours", f"Outside the account's active hours ({a}:00-{b}:00 local). Nothing is sent at this hour.")
    cap = CFG.caps.get(action)
    if cap is not None and _day_count(action) >= cap:
        raise ActionError("daily_cap", f"Daily limit for {action} reached ({cap} in 24h). It frees up as the oldest ones age out.")


def wait_for_gap() -> None:
    lo, hi = CFG.gap_range
    if hi <= 0:
        return
    gap = random.uniform(lo, hi)
    remaining = S.last_write + gap - time.time()
    if remaining > 0:
        time.sleep(min(remaining, 90.0))  # Ariana's client times out at 180s; never wait past that


# ── PARSING ─────────────────────────────────────────────────────────────────

_USER_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
_POST_RE = re.compile(r"instagram\.com/(?:[A-Za-z0-9._]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]{5,20})", re.I)


def norm_username(value: Any) -> str:
    u = str(value or "").strip().lstrip("@")
    if not _USER_RE.match(u):
        raise ActionError("bad_target", "That is not a valid Instagram username.")
    return u


def post_code(url: Any) -> str:
    m = _POST_RE.search(str(url or ""))
    if not m:
        raise ActionError("bad_target", "That is not an Instagram post or reel link (expected instagram.com/p/… or /reel/…).")
    return m.group(1)


def post_url(code: str) -> str:
    return f"https://www.instagram.com/p/{code}/"


def user_pk(cl: Client, username: str) -> tuple:
    """Returns (pk, info). Looking a person up first is also what a user does before acting."""
    info = cl.user_info_by_username_v1(username)
    S.pks[username.lower()] = str(info.pk)
    return str(info.pk), info


# ── ACTIONS ─────────────────────────────────────────────────────────────────

def _profile(info: Any) -> dict:
    return {
        "username": info.username,
        "name": info.full_name,
        "bio": info.biography,
        "followers": info.follower_count,
        "following": info.following_count,
        "posts": info.media_count,
        "is_private": bool(info.is_private),
        "is_verified": bool(info.is_verified),
        "url": f"https://www.instagram.com/{info.username}/",
    }


def do_view_profile(cl: Client, p: dict) -> dict:
    _, info = user_pk(cl, norm_username(p.get("username")))
    return _profile(info)


def do_engagement(cl: Client, p: dict) -> dict:
    prof = do_view_profile(cl, p)
    return {k: prof[k] for k in ("username", "followers", "following", "posts")}


def do_view_posts(cl: Client, p: dict) -> dict:
    username = norm_username(p.get("username"))
    pk, info = user_pk(cl, username)
    if info.is_private:
        raise ActionError("private_account", "That account is private, so its posts cannot be listed.")
    pause(1, 3)
    limit = max(1, min(int(p.get("limit") or 5), 12))
    medias = cl.user_medias_v1(int(pk), amount=limit)
    return {"username": username, "posts": [
        {
            "url": post_url(m.code),
            "caption": (m.caption_text or "")[:200],
            "likes": m.like_count,
            "comments": m.comment_count,
            "posted": m.taken_at.isoformat() if getattr(m, "taken_at", None) else None,
        } for m in medias
    ]}


def do_view_feed(cl: Client, p: dict) -> dict:
    raw = cl.get_timeline_feed() or {}
    posts = []
    for item in (raw.get("feed_items") or []):
        m = (item or {}).get("media_or_ad") or {}
        code = m.get("code")
        if not code:
            continue
        posts.append({
            "url": post_url(code),
            "author": ((m.get("user") or {}).get("username")),
            "caption": (((m.get("caption") or {}).get("text")) or "")[:200],
        })
        if len(posts) >= 10:
            break
    return {"posts": posts}


def do_read_dms(cl: Client, p: dict) -> dict:
    threads = cl.direct_threads(amount=10)
    items = []
    for t in threads:
        last = t.messages[0] if t.messages else None
        who = ", ".join(u.username for u in (t.users or [])) or "unknown"
        items.append({"from": who, "last_message": ((last.text if last else "") or "")[:300]})
    return {"items": items}


def _media_for(cl: Client, url: Any) -> Any:
    pk = cl.media_pk_from_code(post_code(url))
    return cl.media_info_v1(pk)  # also the "look at the post" step before acting on it


def do_like(cl: Client, p: dict) -> dict:
    media = _media_for(cl, p.get("url"))
    pause(2, 6)
    cl.media_like(media.id)
    return {"url": post_url(media.code), "liked": True}


def do_comment(cl: Client, p: dict) -> dict:
    text = str(p.get("text") or "").strip()
    if not text:
        raise ActionError("bad_target", "The comment is empty.")
    if len(text) > 2200:
        raise ActionError("bad_target", "Instagram comments are limited to 2,200 characters.")
    media = _media_for(cl, p.get("url"))
    pause(3, 7)
    if CFG.think:
        time.sleep(typing_time(text))
    c = cl.media_comment(media.id, text)
    return {"url": post_url(media.code), "commented": True, "comment_id": str(getattr(c, "pk", "") or "")}


def do_follow(cl: Client, p: dict) -> dict:
    username = norm_username(p.get("username"))
    pk, _ = user_pk(cl, username)
    pause(2, 5)
    ok = cl.user_follow(int(pk))
    return {"username": username, "followed": bool(ok)}


def do_unfollow(cl: Client, p: dict) -> dict:
    username = norm_username(p.get("username"))
    pk, _ = user_pk(cl, username)
    pause(2, 5)
    ok = cl.user_unfollow(int(pk))
    return {"username": username, "unfollowed": bool(ok)}


def do_dm(cl: Client, p: dict) -> dict:
    username = norm_username(p.get("username"))
    text = str(p.get("message") or "").strip()
    if not text:
        raise ActionError("bad_target", "The message is empty.")
    if len(text) > 1000:
        raise ActionError("bad_target", "That message is too long for one DM (limit 1,000 characters).")
    pk, _ = user_pk(cl, username)
    if not _inbound_from(cl, pk):
        raise ActionError("no_first_dm", f"@{username} has not messaged her first, and she never starts a conversation. Nothing was sent.")
    pause(2, 5)
    if CFG.think:
        time.sleep(typing_time(text))
    cl.direct_send(text, user_ids=[int(pk)])
    return {"username": username, "sent": True}


MAX_IMAGE_BYTES = 20 * 1024 * 1024


def _public_host(host: str) -> bool:
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except Exception:  # noqa: BLE001
        return False


def fetch_image_as_jpeg(url: Any) -> str:
    """Downloads the picture, makes it a JPEG Instagram accepts (RGB, feed aspect ratio) and returns its path."""
    u = urlparse(str(url or ""))
    if u.scheme != "https" or not u.hostname:
        raise ActionError("bad_target", "The image must be an https link.")
    if not _public_host(u.hostname):
        raise ActionError("bad_target", "That image link is not a public address.")
    try:
        r = requests.get(str(url), timeout=30, stream=True)
        r.raise_for_status()
        if not str(r.headers.get("content-type", "")).lower().startswith("image/"):
            raise ActionError("bad_target", "That link is not a picture.")
        buf = io.BytesIO()
        for chunk in r.iter_content(65536):
            buf.write(chunk)
            if buf.tell() > MAX_IMAGE_BYTES:
                raise ActionError("bad_target", "That picture is too large (limit 20 MB).")
    except ActionError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ActionError("bad_target", f"Could not download that picture ({type(e).__name__}).")
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    except Exception:  # noqa: BLE001
        raise ActionError("bad_target", "That file is not a picture Instagram can use.")
    w, h = img.size
    ratio = w / h
    if ratio > 1.91:                      # too wide: crop the sides
        nw = int(h * 1.91); img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    elif ratio < 0.8:                     # too tall: crop top and bottom
        nh = int(w / 0.8); img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    fd, path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    img.save(path, "JPEG", quality=92)
    return path


def do_post(cl: Client, p: dict) -> dict:
    caption = str(p.get("text") or "").strip()
    if len(caption) > 2200:
        raise ActionError("bad_target", "Instagram captions are limited to 2,200 characters.")
    path = fetch_image_as_jpeg(p.get("image_url"))
    try:
        pause(2, 6)
        if CFG.think:
            time.sleep(typing_time(caption) if caption else 2)
        media = cl.photo_upload(path, caption)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return {"url": post_url(media.code), "posted": True}


def _inbound_from(cl: Client, pk: str) -> bool:
    """True only if this person has already messaged her — in the inbox or in message requests."""
    threads = list(cl.direct_threads(amount=40) or [])
    try:
        threads += list(cl.direct_pending_inbox(amount=20) or [])
    except Exception:  # noqa: BLE001 — requests are best effort; the inbox alone decides
        pass
    for t in threads:
        if getattr(t, "is_group", False):
            continue
        if not any(str(u.pk) == str(pk) for u in (t.users or [])):
            continue
        if any(not m.is_sent_by_viewer for m in (t.messages or [])):
            return True
    return False


HANDLERS: dict = {
    "view_profile": do_view_profile, "engagement": do_engagement, "view_posts": do_view_posts,
    "view_feed": do_view_feed, "read_dms": do_read_dms, "like": do_like, "comment": do_comment,
    "follow": do_follow, "unfollow": do_unfollow, "dm": do_dm, "post": do_post,
}
WRITE_COUNTS = {"like": "like", "comment": "comment", "follow": "follow", "unfollow": "unfollow", "dm": "dm", "post": "post"}


def run_action(action: str, handle: Optional[str], payload: dict, session: Optional[dict] = None) -> dict:
    """The one path every action takes. Returns the JSON body; never raises."""
    if action not in HANDLERS:
        return {"success": False, "code": "unsupported", "error": f"\"{action}\" is not something Ariana can do on Instagram through this service."}
    with S.lock:
        try:
            # Validate first: a bad request must cost nothing and never touch Instagram.
            _validate(action, payload)
            if action in WRITE_ACTIONS:
                check_write_allowed(action)
            cl = get_client(session, handle)
            check_account(cl, handle)
            if action in WRITE_ACTIONS:
                wait_for_gap()
            data = HANDLERS[action](cl, payload or {})
            if action in WRITE_ACTIONS:
                S.last_write = time.time()
                S.sent[WRITE_COUNTS[action]].append(time.time())
            return {"success": True, "platform": "instagram", "action": action, "data": data}
        except Exception as e:  # noqa: BLE001 — every failure becomes a code Ariana can say out loud
            err = classify(e)
            if err.cooldown_hours > 0:
                S.cooldown_until = time.time() + err.cooldown_hours * 3600
                S.cooldown_code = err.code
            if err.code in ("session_expired", "challenge", "no_session"):
                S.client = None
                S.identity = None
                S.session_hash = None
            if err.code == "ig_error":
                LOG.warning("instagram action %s failed: %s: %s", action, type(e).__name__, e)
            return {"success": False, "code": err.code, "error": err.error}


def _validate(action: str, p: dict) -> None:
    p = p or {}
    if action in ("view_profile", "engagement", "view_posts", "follow", "unfollow", "dm"):
        norm_username(p.get("username"))
    if action in ("like", "comment"):
        post_code(p.get("url"))
    if action == "comment" and not str(p.get("text") or "").strip():
        raise ActionError("bad_target", "The comment is empty.")
    if action == "dm" and not str(p.get("message") or "").strip():
        raise ActionError("bad_target", "The message is empty.")
    if action == "post" and not str(p.get("image_url") or "").strip():
        raise ActionError("bad_target", "Instagram posts need a picture — no image was given.")


# ── HTTP ────────────────────────────────────────────────────────────────────

app = FastAPI(title="Ariana Instagram service", docs_url=None, redoc_url=None, openapi_url=None)


def auth(x_api_key: Optional[str]) -> None:
    key = CFG.api_key
    if not key or not x_api_key or not hmac.compare_digest(
        hashlib.sha256(x_api_key.encode()).digest(), hashlib.sha256(key.encode()).digest()
    ):
        raise HTTPException(status_code=401, detail="Invalid or missing X-Api-Key.")


class ActBody(BaseModel):
    handle: Optional[str] = None
    payload: dict = Field(default_factory=dict)
    session: Optional[dict] = None


class VerifyBody(BaseModel):
    handle: Optional[str] = None
    session: Optional[dict] = None


class LoginBody(BaseModel):
    username: str
    password: str
    code: Optional[str] = None


class InboxBody(BaseModel):
    handle: Optional[str] = None
    session: Optional[dict] = None
    include_requests: bool = False


@app.get("/ping")
def ping() -> dict:
    """Unauthenticated, touches nothing: for the host's health check only."""
    return {"ok": True}


@app.get("/health")
def health(x_api_key: Optional[str] = Header(default=None)) -> dict:
    auth(x_api_key)
    now = time.time()
    return {
        "provider": "instagrapi",
        "status": "ok",
        "signed_in": S.client is not None,
        "cooldown_minutes": max(0, int((S.cooldown_until - now) / 60)) if now < S.cooldown_until else 0,
        "sent_24h": {a: _day_count(a) for a in WRITE_ACTIONS},
        "caps": CFG.caps,
    }


@app.post("/verify")
def verify(body: VerifyBody, x_api_key: Optional[str] = Header(default=None)) -> dict:
    """The one deliberate live check (Connect): proves the session works and which account it is."""
    auth(x_api_key)
    with S.lock:
        try:
            cl = get_client(body.session, body.handle)
            me = whoami(cl, fresh=True)
            wanted = (body.handle or CFG.username or "").lstrip("@").lower()
            if wanted and me != wanted:
                return {"connected": False, "detail": f"Signed in as @{me}, not @{wanted}. Reconnect the right account."}
            note = ""
            if time.time() < S.cooldown_until:
                note = f" Writes are paused for now ({S.cooldown_code})."
            return {"connected": True, "handle": me, "detail": f"Verified live: signed in as @{me}.{note}"}
        except Exception as e:  # noqa: BLE001
            err = classify(e)
            if err.code in ("session_expired", "challenge", "no_session"):
                S.client = None
                S.identity = None
                S.session_hash = None
            return {"connected": False, "code": err.code, "detail": err.error}


@app.post("/login")
def login(body: LoginBody, x_api_key: Optional[str] = Header(default=None)) -> dict:
    """One-time sign-in for the dashboard's Connect form. The password is used for this call only —
    never stored, never logged. The returned settings are the session Ariana keeps in her database."""
    auth(x_api_key)
    username = body.username.strip().lstrip("@")
    if not _USER_RE.match(username) or not body.password:
        return {"connected": False, "code": "bad_input", "detail": "Enter the Instagram username and password."}
    with S.lock:
        if time.time() - S.last_login < 8:
            return {"connected": False, "code": "slow_down", "detail": "Wait a few seconds before trying again."}
        S.last_login = time.time()
        try:
            cl = new_client(username)
            cl.login(username, body.password, verification_code=(body.code or "").strip())
            me = (getattr(cl, "username", None) or username).lower()
            return {"connected": True, "handle": me, "settings": cl.get_settings(), "detail": f"Signed in as @{me}."}
        except ex.TwoFactorRequired:
            return {"connected": False, "code": "two_factor", "detail": "Instagram needs your 6-digit security code (authenticator app is most reliable). Enter it and press Connect again."}
        except Exception as e:  # noqa: BLE001
            if isinstance(e, getattr(ex, "BadPassword", ())) or isinstance(e, getattr(ex, "BadCredentials", ())):
                return {"connected": False, "code": "bad_password", "detail": "Instagram says the username or password is wrong."}
            err = classify(e)
            if err.code == "ig_error" and re.search(r"code|two.?factor|verification", str(e), re.I):
                return {"connected": False, "code": "bad_code", "detail": "That security code was not accepted. Get a fresh one and try again."}
            return {"connected": False, "code": err.code, "detail": err.error}


def _preview(m: Any) -> str:
    t = (getattr(m, "text", None) or "").strip()
    if t:
        return t[:1000]
    kind = str(getattr(m, "item_type", "") or "message")
    return f"[sent a {kind.replace('_', ' ')}]"


@app.post("/inbox")
def inbox(body: InboxBody, x_api_key: Optional[str] = Header(default=None)) -> dict:
    """Latest messages in her inbox (and optionally message requests), for the dashboard poller.
    Read-only: it marks nothing as seen and sends nothing."""
    auth(x_api_key)
    with S.lock:
        try:
            cl = get_client(body.session, body.handle)
            check_account(cl, body.handle)
            threads = [(t, False) for t in (cl.direct_threads(amount=15) or [])]
            if body.include_requests:
                try:
                    threads += [(t, True) for t in (cl.direct_pending_inbox(amount=15) or [])]
                except Exception:  # noqa: BLE001
                    pass
            out = []
            for t, is_request in threads:
                if getattr(t, "is_group", False) or not t.users:
                    continue
                u = t.users[0]
                msgs = []
                for m in list(t.messages or [])[:6]:
                    msgs.append({
                        "id": str(m.id),
                        "text": _preview(m),
                        "from_them": not m.is_sent_by_viewer,
                        "at": m.timestamp.isoformat() if getattr(m, "timestamp", None) else None,
                    })
                out.append({"thread_id": str(t.id), "username": u.username, "user_id": str(u.pk), "request": is_request, "messages": msgs})
            return {"success": True, "threads": out}
        except Exception as e:  # noqa: BLE001
            err = classify(e)
            if err.code in ("session_expired", "challenge", "no_session"):
                S.client = None
                S.identity = None
                S.session_hash = None
            return {"success": False, "code": err.code, "error": err.error}


@app.post("/act/{action}")
def act(action: str, body: ActBody, x_api_key: Optional[str] = Header(default=None)) -> dict:
    auth(x_api_key)
    return run_action(action, body.handle, body.payload, body.session)


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    require_env()
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "10000")), workers=1, log_level="info", access_log=False)
