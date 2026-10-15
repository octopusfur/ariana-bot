"""bridge.py - Ariana's Snapchat bridge logic (no HTTP here, so it can be unit tested).

Wraps the vendored unofficial Snapchat Web client with the guard rails a bot needs:
  * every client call is serialised (the client is not thread safe)
  * one automatic bearer refresh + retry when the session has expired
  * inbound polling over an ALLOWLIST of conversations only, baselined on start so old
    history is never replied to, with an echo guard so her own messages never loop back
  * per-conversation send rate limit
"""
import hashlib
import os
import re
import tempfile
import threading
import time
import uuid as uuid_mod
from collections import defaultdict, deque

from snapchat import AuthError, GrpcError, SnapchatClient, SnapchatError

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
ALLOWED_DOWNLOAD_HOSTS = ("sc-cdn.net", "snapchat.com")
UNSUPPORTED = {
    "post_story": "The upstream library cannot post Stories yet (no known endpoint).",
    "like": "The upstream library cannot like content yet (it needs a WebSocket capture).",
    "comment": "The upstream library cannot comment yet (it needs a WebSocket capture).",
    "follow": "The upstream library cannot follow accounts yet (it needs a WebSocket capture).",
}


def is_uuid(value):
    return bool(value) and bool(UUID_RE.match(str(value)))


def extract_uuid_candidates(raw, exclude=()):
    """Find 16-byte ids framed as protobuf `0A 10 <16 bytes>` whose bits look like UUID v4/v5.

    This is a best-effort scan of a raw protobuf blob; it only SUGGESTS ids. Nothing is ever
    polled or messaged until the owner adds an id to the allowlist.
    """
    skip = {bytes.fromhex(str(e).replace("-", "")) for e in exclude if is_uuid(e)}
    out, seen = [], set()
    i = 0
    while True:
        i = raw.find(b"\x0a\x10", i)
        if i < 0 or i + 18 > len(raw):
            break
        chunk = raw[i + 2:i + 18]
        if (chunk[6] >> 4) in (4, 5) and (chunk[8] >> 6) == 2 and chunk not in seen and chunk not in skip:
            seen.add(chunk)
            out.append(str(uuid_mod.UUID(bytes=chunk)))
        i += 1
    return out


def _looks_like_uuid_bytes(chunk):
    return len(chunk) == 16 and (chunk[6] >> 4) in (4, 5) and (chunk[8] >> 6) == 2


def extract_conversation_ids(raw, exclude=()):
    """Conversation references in a sync payload are framed `0A 12 0A 10 <16 bytes>` (same shape send_text builds).

    Best effort and unverified against a live account: it only SUGGESTS ids. Anything it finds is checked by
    actually reading messages from it, and ids that never yield a message are simply ignored.
    """
    skip = {bytes.fromhex(str(e).replace("-", "")) for e in exclude if is_uuid(e)}
    out, seen, i = [], set(), 0
    while True:
        i = raw.find(b"\x0a\x12\x0a\x10", i)
        if i < 0 or i + 20 > len(raw):
            break
        chunk = raw[i + 4:i + 20]
        if _looks_like_uuid_bytes(chunk) and chunk not in seen and chunk not in skip:
            seen.add(chunk)
            out.append(str(uuid_mod.UUID(bytes=chunk)))
        i += 1
    return out


def user_id_candidates(token):
    """Possible account ids hidden in a bearer token: UUID text, or 16-byte values with UUID bits."""
    import base64
    cands, seen = [], set()

    def add(u):
        u = str(u).lower()
        if is_uuid(u) and u not in seen:
            seen.add(u)
            cands.append(u)

    for m in re.finditer(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", token or ""):
        add(m.group(0))
    raw = b""
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            t = (token or "").strip()
            raw = decoder(t + "=" * (-len(t) % 4))
            break
        except Exception:
            continue
    for m in re.finditer(rb"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", raw):
        add(m.group(0).decode())
    for i in range(0, max(0, len(raw) - 15)):
        if _looks_like_uuid_bytes(raw[i:i + 16]) and (i == 0 or raw[i - 1] == 0x10 or raw[i - 2:i] == b"\x0a\x10"):
            add(uuid_mod.UUID(bytes=raw[i:i + 16]))
    return cands[:12]


def text_key(conversation_id, text):
    return hashlib.sha256(f"{conversation_id}\x00{text.strip()}".encode("utf-8")).hexdigest()[:24]


class RateLimiter:
    def __init__(self, limit, window=3600.0, clock=time.time):
        self.limit, self.window, self.clock = limit, window, clock
        self.hits = defaultdict(deque)

    def allow(self, key):
        now = self.clock()
        q = self.hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


class Bridge:
    def __init__(self, on_inbound=None, my_uuid="", conversations=(), max_sends_per_hour=30, client_factory=SnapchatClient, answer_all=True):
        self.lock = threading.RLock()
        self.client_factory = client_factory
        self.client = None
        self.my_uuid = my_uuid
        self.conversations = {c.lower() for c in conversations if is_uuid(c)}
        self.on_inbound = on_inbound
        self.limiter = RateLimiter(max_sends_per_hour)
        self.seen = defaultdict(set)      # conversation -> text keys already handled
        self.baselined = set()            # conversations whose history was recorded silently
        self.sent = deque(maxlen=500)     # echo guard: keys of what we sent ourselves
        self.last_poll = None
        self.last_error = None
        self.paused = False
        self.answer_all = answer_all      # True: answer every chat found in the sync; False: only listed chats
        self.initial_done = False         # first full pass only records history
        self.known = set()                # chats found automatically so far

    # ---------------------------------------------------------------- session
    def authenticated(self):
        return bool(self.client and self.client.is_authenticated())

    def _new_client(self, cookies=None, bearer=""):
        self.client = self.client_factory(cookies=cookies, bearer_token=bearer, my_uuid=self.my_uuid)
        return self.client

    def set_user_uuid(self, value):
        if not is_uuid(value):
            raise SnapchatError("user_uuid must look like 8-4-4-4-12 hex")
        with self.lock:
            self.my_uuid = value.lower()
            if self.client:
                self.client.MY_UUID = bytes.fromhex(self.my_uuid.replace("-", ""))
            self.baselined.clear()
            self.initial_done = False

    def login(self, username, password):
        with self.lock:
            c = self._new_client()
            res = c.login(username, password)
            return {"cookies": res["cookies"], "bearer_token": res["bearer_token"]}

    def load_session(self, cookies, bearer=""):
        """cookies: dict name->value, or a browser export (list of {name,value})."""
        with self.lock:
            if isinstance(cookies, list):
                cookies = {str(c["name"]): str(c["value"]) for c in cookies if c.get("name")}
            if not isinstance(cookies, dict) or not cookies:
                raise SnapchatError("no cookies supplied")
            c = self._new_client(cookies={str(k): str(v) for k, v in cookies.items()}, bearer=bearer or "")
            if not bearer:
                c.refresh_bearer()
            return {"cookies": c.cookies, "bearer_token": c.bearer_token}

    def logout(self):
        with self.lock:
            self.client = None
            self.seen.clear()
            self.baselined.clear()

    def _call(self, fn_name, *args, **kwargs):
        """Run a client method under the lock; refresh the bearer once if the session expired."""
        with self.lock:
            if not self.authenticated():
                raise AuthError("Snapchat is not signed in")
            if not self.my_uuid and fn_name in ("send_text", "send_media", "delta_sync", "get_messages"):
                raise SnapchatError("SNAPCHAT_USER_UUID is not set; refusing to act as the wrong account")
            fn = getattr(self.client, fn_name)
            for attempt in (0, 1):
                try:
                    res = fn(*args, **kwargs)
                    if isinstance(res, dict) and res.get("status") == "error" and attempt == 0 and re.search(r"grpc-status=(7|16)\b", str(res.get("error", ""))):
                        raise AuthError(res["error"])
                    return res
                except (AuthError, GrpcError) as e:
                    expired = isinstance(e, AuthError) or getattr(e, "status", None) in (7, 16)
                    if attempt == 0 and expired and self.client.cookies:
                        self.client.refresh_bearer()
                        continue
                    raise


    def discover_user_uuid(self):
        """Find this account's own id by trying candidates from the bearer token against a real sync.

        A wrong id makes Snapchat reject the sync, so only an id that works is accepted. Returns it, or None.
        """
        with self.lock:
            if not self.authenticated():
                raise AuthError("Snapchat is not signed in")
            previous = self.my_uuid
            for cand in user_id_candidates(self.client.bearer_token):
                self.my_uuid = cand
                self.client.MY_UUID = bytes.fromhex(cand.replace("-", ""))
                try:
                    data = self.client.delta_sync()
                except Exception:
                    continue
                if isinstance(data, (bytes, bytearray)) and len(data) > 32:
                    self.initial_done = False
                    self.baselined.clear()
                    return cand
            self.my_uuid = previous
            self.client.MY_UUID = bytes.fromhex(previous.replace("-", "")) if previous else b""
            return None

    # ---------------------------------------------------------------- sending
    def _check_conv(self, conversation_id):
        if not is_uuid(conversation_id):
            raise SnapchatError("conversation_id must be a UUID")
        return conversation_id.lower()

    def send_text(self, conversation_id, text):
        conv = self._check_conv(conversation_id)
        text = str(text or "").strip()
        if not text:
            raise SnapchatError("empty message")
        if not self.limiter.allow(conv):
            raise SnapchatError("send rate limit reached for this conversation")
        res = self._call("send_text", conv, text)
        if res.get("status") != "ok":
            raise SnapchatError(f"send failed: {res.get('error', 'unknown')}")
        self.sent.append(text_key(conv, text))
        return res

    def send_media(self, conversation_id, filename, data):
        conv = self._check_conv(conversation_id)
        if not self.limiter.allow(conv):
            raise SnapchatError("send rate limit reached for this conversation")
        ext = os.path.splitext(filename or "")[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".webm"):
            ext = ".jpg"
        fd, path = tempfile.mkstemp(suffix=ext)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            res = self._call("send_media", conv, path)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        if res.get("status") not in ("ok", None) and res.get("error"):
            raise SnapchatError(f"send failed: {res['error']}")
        return res

    # ---------------------------------------------------------------- reading
    def candidates(self):
        raw = self._call("delta_sync")
        return extract_uuid_candidates(raw, exclude=[self.my_uuid])

    def set_conversations(self, add=(), remove=(), replace=None):
        with self.lock:
            if replace is not None:
                self.conversations = {c.lower() for c in replace if is_uuid(c)}
            for c in add:
                if is_uuid(c):
                    self.conversations.add(c.lower())
            for c in remove:
                self.conversations.discard(str(c).lower())
                self.baselined.discard(str(c).lower())
            return sorted(self.conversations)

    def poll_once(self):
        """One polling pass. Returns the new inbound messages that were delivered.

        answer_all (default): one sync is shared across every chat found in it, plus any listed chats.
        The first pass after start only records history (never answered); chats that appear later are new
        conversations, so their messages are answered (newest 3 at most, in case history shows up late).
        """
        if self.paused or not self.authenticated() or not self.my_uuid:
            return []
        data = None
        convs = set(self.conversations)
        if self.answer_all:
            try:
                data = self._call("delta_sync")
            except SnapchatError as e:
                self.last_error = str(e)
                return []
            if isinstance(data, (bytes, bytearray)):
                found = extract_conversation_ids(bytes(data), exclude=[self.my_uuid])
                self.known.update(found)
                convs |= set(found)
        first_pass = not self.initial_done
        delivered = []
        for conv in sorted(convs):
            try:
                msgs = self._call("get_messages", conv, 50, data) if data is not None else self._call("get_messages", conv, 50)
            except SnapchatError as e:
                self.last_error = str(e)
                continue
            keys = [(m, text_key(conv, m["text"])) for m in msgs]
            fresh_chat = conv not in self.baselined
            if fresh_chat and (first_pass or conv in self.conversations or not self.answer_all):
                for _, k in keys:
                    self.seen[conv].add(k)   # history before we started is never answered
                self.baselined.add(conv)
                continue
            self.baselined.add(conv)
            ordered = list(reversed(keys))   # oldest first
            if fresh_chat:                   # brand new chat found after start: answer only its newest 3
                for _, k in ordered[:-3]:
                    self.seen[conv].add(k)
                ordered = ordered[-3:]
            for m, k in ordered:
                if k in self.seen[conv]:
                    continue
                self.seen[conv].add(k)
                if m.get("sender") != "other" or k in self.sent:
                    continue
                delivered.append({"conversation_id": conv, "text": m["text"]})
                if self.on_inbound:
                    try:
                        self.on_inbound(conv, m["text"])
                    except Exception as e:   # never let one bad delivery kill the loop
                        self.last_error = f"inbound delivery failed: {e}"
            if len(self.seen[conv]) > 2000:
                self.seen[conv] = set(list(self.seen[conv])[-1000:])
        if self.answer_all and data is not None:
            self.initial_done = True
        self.last_poll = time.time()
        return delivered

    def download(self, url):
        host = (re.match(r"^https://([^/:]+)", url or "") or [None, ""])[1].lower()
        if not host or not any(host == h or host.endswith("." + h) for h in ALLOWED_DOWNLOAD_HOSTS):
            raise SnapchatError("only https Snapchat CDN hosts may be downloaded")
        d = tempfile.mkdtemp()
        res = self._call("download_media", url, os.path.join(d, "dl"))
        if res.get("error"):
            raise SnapchatError(res["error"])
        return res
