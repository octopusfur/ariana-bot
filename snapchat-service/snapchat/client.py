"""Snapchat Web API Client — Unofficial Python client for www.snapchat.com

Sends text, image, and video messages by reverse-engineering the gRPC-web API.

Auth Flow:
  1. Login at accounts.snapchat.com → session cookies
  2. POST accounts.snapchat.com/accounts/sso → Bearer token (292-char base64, starts hCgwK...)
  3. Use Authorization: Bearer + Cookies on web.snapchat.com gRPC-web endpoints

Media Send Pipeline:
  getUploadLocations → AES-256-CBC encrypt → PUT to CDN → CreateContentMessage

Requires: curl_cffi (impersonate="chrome131"), pycryptodome
"""

from __future__ import annotations

import base64, json, os, random, re, struct, sys, time, uuid as uuid_mod
from dataclasses import dataclass, field
from typing import Optional

try:
    from curl_cffi import requests
except ImportError:
    raise ImportError(
        "curl_cffi is required. Install with: pip install curl-cffi"
    ) from None

try:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
except ImportError:
    raise ImportError(
        "pycryptodome is required. Install with: pip install pycryptodome"
    ) from None

# Template path: look in package parent dir's snap_capture/ folder
_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_PACKAGE_DIR)
TEMPLATE_PATH = os.path.join(
    _PROJECT_ROOT,
    "snap_capture",
    "0172_https___web_snapchat_com_messagingcoreservice_MessagingCoreS.bin",
)


def _encode_varint(val: int) -> bytes:
    buf = []
    while True:
        byte = val & 0x7F
        val >>= 7
        if val:
            byte |= 0x80
        buf.append(byte)
        if not val:
            break
    return bytes(buf)


def _read_varint(data: bytes, pos: int) -> tuple:
    v = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        v |= (b & 0x7F) << shift
        shift += 7
        pos += 1
        if not (b & 0x80):
            return v, pos
    return v, pos


def _decode_uuid(hex_str: str) -> bytes:
    return uuid_mod.UUID(hex_str).bytes


def _format_uuid(raw: bytes) -> str:
    return str(uuid_mod.UUID(bytes=raw))


class SnapchatError(Exception):
    pass


class AuthError(SnapchatError):
    """Authentication failed (bad credentials, expired session, etc.)"""

    pass


class GrpcError(SnapchatError):
    """gRPC-web call returned an error status"""

    def __init__(self, status: int, message: str = "", details: str = ""):
        self.status = status
        self.message = message
        self.details = details
        super().__init__(f"grpc-status={status}: {message}")


UUID_TEXT = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _response_cookies(r) -> dict:
    try:
        return {str(k): str(v) for k, v in dict(r.cookies).items()}
    except Exception:
        return {}


def _parse_login_challenge(payload: bytes):
    """Return (status, challenge_bytes) from the email-step reply: field 1 varint, field 2 bytes."""
    status, challenge, pos = None, None, 0
    while pos < len(payload):
        key, pos = _read_varint(payload, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            val, pos = _read_varint(payload, pos)
            if field == 1:
                status = val
        elif wire == 2:
            n, pos = _read_varint(payload, pos)
            if field == 2 and challenge is None:
                challenge = payload[pos:pos + n]
            pos += n
        elif wire == 1:
            pos += 8
        elif wire == 5:
            pos += 4
        else:
            break
    return status, challenge


class SnapchatClient:
    """Unofficial Snapchat Web API client.

    Usage:
        client = SnapchatClient()
        client.login_playwright("user@example.com", "password")
        # or: client.load_session("auth_capture/session.json")
        client.send_text("6e609ac8-04ed-45b8-9dee-002cdaf13db5", "Hello!")
        client.send_image("6e609ac8-04ed-45b8-9dee-002cdaf13db5", "photo.jpg")
    """

    # Known good values
    # PATCHED: upstream hardcodes the original author's account UUID here. It is now per-instance
    # (see __init__) and empty until the real account's UUID is supplied.
    MY_UUID = b""
    TEAM_CONV = _decode_uuid("6e609ac8-04ed-45b8-9dee-002cdaf13db5")
    FENU_CONV = _decode_uuid("10f7f579-e331-5423-8a07-92b9fcb7be77")

    def __init__(
        self,
        cookies: Optional[dict] = None,
        bearer_token: str = "",
        my_uuid: str = "",
    ):
        self.MY_UUID = _decode_uuid(my_uuid) if my_uuid else b""
        self.cookies: dict = cookies or {}
        self.bearer_token: str = bearer_token
        self._template_cache: Optional[bytearray] = None
        self._base_headers = {
            "Content-Type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (windows 10; webkit 537.36)",
            "Origin": "https://www.snapchat.com",
            "Referer": "https://www.snapchat.com/web",
        }

    # ── Constants for login ──────────────────────────────────────────────
    WEBLOGIN_URL = (
        "https://accounts.snapchat.com/snapchat.janus.api.WebLoginService/WebLogin"
    )
    SSO_URL = "https://accounts.snapchat.com/accounts/sso"
    LOGIN_PAGE = "https://accounts.snapchat.com/v2/login"

    @staticmethod
    def _encode_varint(val: int) -> bytes:
        buf = []
        while True:
            byte = val & 0x7F
            val >>= 7
            if val:
                byte |= 0x80
            buf.append(byte)
            if not val:
                break
        return bytes(buf)

    @staticmethod
    def _decode_varint(data: bytes, pos: int) -> tuple[int, int]:
        v = 0
        shift = 0
        while True:
            b = data[pos]
            v |= (b & 0x7F) << shift
            shift += 7
            pos += 1
            if not (b & 0x80):
                break
        return v, pos

    def _grpc_post(
        self,
        url: str,
        protobuf: bytes,
        cookies: dict = None,
        origin: str = "",
        timeout: int = 30,
    ) -> requests.Response:
        """Low-level gRPC-web POST (for login flow where cookies aren't set yet)."""
        frame = struct.pack("!BI", 0, len(protobuf)) + protobuf
        h = {
            "Content-Type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
        }
        if origin:
            h["Origin"] = origin
            h["Referer"] = origin + "/"
        r = requests.post(
            url,
            data=frame,
            headers=h,
            cookies=cookies or {},
            impersonate="chrome131",
            timeout=timeout,
        )
        return r

    def login(self, username: str, password: str) -> dict:
        """Login via direct HTTP gRPC (no browser needed).

        Two-step WebLogin flow:
          1. Send email → get pwd challenge
          2. Send password + challenge → get auth cookies
        Then refreshes the Bearer token via SSO.

        Args:
            username: Email or username
            password: Account password

        Returns: {cookies (dict), bearer_token (str)}

        Raises: AuthError on failure (bad credentials, rate limited, etc.)
        """
        from curl_cffi import requests as _req

        sess = _req.Session()
        sess.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
            }
        )

        # Step 1: Load login page for initial cookies
        r = sess.get(self.LOGIN_PAGE, impersonate="chrome131", timeout=30)
        if r.status_code != 200:
            raise AuthError(f"Login page returned HTTP {r.status_code}")

        origin = "https://accounts.snapchat.com"
        jar = dict(sess.cookies)  # PATCHED: carry cookies from every step (upstream dropped the ones set by the WebLogin replies)

        # Step 2: Submit email via WebLogin
        email_bytes = username.encode()
        req1 = bytearray()
        req1.append(0x1A)  # field 3 = email string
        req1.append(len(email_bytes))
        req1.extend(email_bytes)

        r = self._grpc_post(
            self.WEBLOGIN_URL,
            bytes(req1),
            cookies=jar,
            origin=origin,
            timeout=15,
        )
        if r.status_code != 200 or b"grpc-status:0" not in r.content:
            err_msg = "Email step failed"
            if r.content:
                err_text = self._extract_grpc_error(r.content)
                if err_text:
                    err_msg += f": {err_text}"
            raise AuthError(err_msg)

        jar.update(_response_cookies(r))

        # Parse challenge from response
        payload = self._parse_grpc_payload(r)
        if not payload:
            raise AuthError("Empty email response")

        # PATCHED: walk the fields. Upstream assumed the challenge tag sat at byte 1, but the reply is
        # `08 0d 12 ..` (status 13 = "send the password", then the challenge), so it read the status value as a tag.
        status, challenge_sub = _parse_login_challenge(payload)
        if challenge_sub is None:
            raise AuthError(
                f"Snapchat did not ask for a password (status {status}). It may want a captcha or "
                "verification first, or it refused this server."
            )

        # Step 3: Submit password with challenge
        pw_bytes = password.encode()
        redirect = b"/v2/welcome"

        req2 = bytearray()
        req2.append(0x12)  # field 2 = challenge submessage
        req2.extend(self._encode_varint(len(challenge_sub)))
        req2.extend(challenge_sub)
        req2.append(0x1A)  # field 3 = password
        req2.append(len(pw_bytes))
        req2.extend(pw_bytes)
        req2.append(0x22)  # field 4 = redirect URL
        req2.append(len(redirect))
        req2.extend(redirect)

        r = self._grpc_post(
            self.WEBLOGIN_URL,
            bytes(req2),
            cookies=jar,
            origin=origin,
            timeout=15,
        )
        if r.status_code != 200 or b"grpc-status:0" not in r.content:
            err_msg = "Password step failed"
            if r.content:
                err_text = self._extract_grpc_error(r.content)
                if err_text:
                    err_msg += f": {err_text}"
            raise AuthError(err_msg)

        # Collect cookies from the session
        jar.update(_response_cookies(r))
        self.cookies = jar

        # Step 4: Refresh bearer token via SSO
        if self.cookies:
            self.refresh_bearer()

        return {"cookies": self.cookies, "bearer_token": self.bearer_token}

    def signup(
        self,
        email: str,
        username: str,
        password: str,
        first_name: str,
        birthdate: tuple[int, int, int],
        timezone: str = "America/New_York",
        ignore_welcome_email: bool = False,
    ) -> dict:
        """Create a new Snapchat account via gRPC WebRegister.

        Uses the WebRegister method of RegistrationService on accounts.snapchat.com.
        The request requires webRegistrationHeader (field 1), account fields,
        and webRegistrationHeaderBrowser (field 11).

        Status codes returned by the API:
          - 1 (SUCCESS): account created, auth cookies set
          - 2 (CHALLENGED): requires challenge verification
          - 10 (ERR_THROTTLED): rate limited
          - 11 (ERR_INVALID_PASSWORD): bad password
          - 12 (ERR_WEAK_PASSWORD): weak password
          - 16 (ERR_INVALID_USERNAME): bad username format
          - 17 (ERR_USERNAME_TAKEN): username taken
          - 18 (ERR_EMAIL_TAKEN): email already used
          - 19 (ERR_INVALID_EMAIL): bad email
          - 21 (ERR_BLOCKED): blocked

        Args:
            email: Account email
            username: Snapchat username (3-15 chars, letters/numbers/._)
            password: Account password
            first_name: Display name
            birthdate: Tuple of (year, month, day)
            timezone: IANA timezone string
            ignore_welcome_email: Skip welcome email

        Returns:
            Dict with keys: cookies, bearer_token, status_code, status_name,
            error_field (int), error_message (str)

        Raises AuthError on HTTP/network errors.
        """
        from curl_cffi import requests as _req

        # Build the WebRegister protobuf manually

        # birthdate submessage: fields 1=year, 2=month, 3=day
        year, month, day = birthdate
        bd = bytearray()
        bd.append(0x08)
        bd.extend(self._encode_varint(year))
        bd.append(0x10)
        bd.extend(self._encode_varint(month))
        bd.append(0x18)
        bd.extend(self._encode_varint(day))

        # webRegistrationHeader (field 1): user agent info
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0"
        ua_bytes = ua.encode()
        hdr = bytearray()
        hdr.append(0x22)
        hdr.extend(self._encode_varint(len(ua_bytes)))
        hdr.extend(ua_bytes)

        # webRegistrationHeaderBrowser (field 11): browser info
        hdr_browser = bytearray()
        hdr_browser.append(0x28)
        hdr_browser.extend(self._encode_varint(2))  # version=V2

        # Main request
        req = bytearray()
        req.append(0x0A)
        req.extend(self._encode_varint(len(hdr)))
        req.extend(hdr)
        eb = email.encode()
        req.append(0x12)
        req.extend(self._encode_varint(len(eb)))
        req.extend(eb)
        ub = username.encode()
        req.append(0x1A)
        req.extend(self._encode_varint(len(ub)))
        req.extend(ub)
        pb = password.encode()
        req.append(0x22)
        req.extend(self._encode_varint(len(pb)))
        req.extend(pb)
        fnb = first_name.encode()
        req.append(0x2A)
        req.extend(self._encode_varint(len(fnb)))
        req.extend(fnb)
        req.append(0x3A)
        req.extend(self._encode_varint(len(bd)))
        req.extend(bd)
        tzb = timezone.encode()
        req.append(0x42)
        req.extend(self._encode_varint(len(tzb)))
        req.extend(tzb)
        if ignore_welcome_email:
            req.append(0x48)
            req.append(0x01)
        req.append(0x5A)
        req.extend(self._encode_varint(len(hdr_browser)))
        req.extend(hdr_browser)

        # Frame for gRPC-web
        frame = struct.pack("!BI", 0, len(req)) + bytes(req)

        # Get initial signup page cookies
        sess = _req.Session()
        sess.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
            }
        )
        sess.get(
            "https://accounts.snapchat.com/v2/signup",
            impersonate="chrome131",
            timeout=30,
        )

        headers = {
            "Content-Type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (windows 10; webkit 537.36)",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
            "Origin": "https://accounts.snapchat.com",
            "Referer": "https://accounts.snapchat.com/v2/signup",
        }
        # Use module-level requests.post with explicit cookies, NOT sess.post
        r = requests.post(
            "https://accounts.snapchat.com/snapchat.janus.api.RegistrationService/WebRegister",
            data=frame,
            headers=headers,
            cookies=dict(sess.cookies),
            impersonate="chrome131",
            timeout=15,
        )

        # Check gRPC status
        grpc_ok = False
        if r.status_code == 200:
            if b"grpc-status:0" in r.content:
                grpc_ok = True
            elif "grpc-status" in r.headers and r.headers["grpc-status"] == "0":
                grpc_ok = True

        if not grpc_ok:
            # Try to extract grpc error from headers first
            gs = r.headers.get("grpc-status", "")
            gm = r.headers.get("grpc-message", "")
            if gs and gm:
                raise AuthError(f"WebRegister failed: grpc-status={gs} {gm}")
            # Then from body trailer
            if r.content:
                err_text = self._extract_grpc_error(r.content)
                if err_text:
                    raise AuthError(f"WebRegister failed: {err_text}")
            raise AuthError(f"WebRegister failed: HTTP {r.status_code}")

        # Parse response protobuf
        payload = self._parse_grpc_payload(r) if r.content else None

        # Extract cookies from set-cookie headers
        self.cookies = dict(sess.cookies)
        # Also parse Set-Cookie from response
        set_cookie = r.headers.get("set-cookie", "")
        if set_cookie:
            for part in set_cookie.split(","):
                if "=" in part:
                    name = part.split("=")[0].strip()
                    # Find value (up to ; or end)
                    rest = part[len(name) + 1 :]
                    val = rest.split(";")[0].strip()
                    if name and val:
                        self.cookies[name] = val

        result = {
            "cookies": self.cookies,
            "bearer_token": self.bearer_token or "",
            "status_code": 0,
            "status_name": "",
            "error_field": 0,
            "error_message": "",
        }

        if payload:
            pos = 0
            while pos < len(payload):
                tag = payload[pos]
                pos += 1
                fn = tag >> 3
                wt = tag & 7
                if wt == 0:
                    val, pos = self._decode_varint(payload, pos)
                    if fn == 1:
                        result["status_code"] = val
                elif wt == 2:
                    length, pos = self._decode_varint(payload, pos)
                    data = bytes(payload[pos : pos + length])
                    pos += length
                    if fn == 4:
                        # errorData submessage
                        ep = 0
                        while ep < len(data):
                            et = data[ep]
                            ep += 1
                            efn = et >> 3
                            ewt = et & 7
                            if ewt == 0:
                                ev, ep = self._decode_varint(data[ep:], 0)
                                if efn == 1:
                                    result["error_field"] = ev
                            elif ewt == 2:
                                el, ep = self._decode_varint(data[ep:], 0)
                                try:
                                    result["error_message"] = data[ep : ep + el].decode(
                                        "utf-8", errors="replace"
                                    )
                                except:
                                    result["error_message"] = data[ep : ep + el].hex()
                                ep += el
                            else:
                                break
                    elif fn in (2, 3, 5, 6):
                        result["payload_raw"] = data
                else:
                    break

        # Map status code to name
        STATUS_NAMES = {
            0: "UNSET",
            1: "SUCCESS",
            2: "CHALLENGED",
            10: "ERR_THROTTLED",
            11: "ERR_INVALID_PASSWORD",
            12: "ERR_WEAK_PASSWORD",
            13: "ERR_USERNAME_SAME_WITH_PASSWORD",
            14: "ERR_INVALID_DISPLAY_NAME",
            15: "ERR_INVALID_BIRTHDATE",
            16: "ERR_INVALID_USERNAME",
            17: "ERR_USERNAME_TAKEN",
            18: "ERR_EMAIL_TAKEN",
            19: "ERR_INVALID_EMAIL",
            20: "ERR_SEND_EMAIL_FAIL",
            21: "ERR_BLOCKED",
            22: "ERR_INELIGIBLE_FOR_REGISTRATION",
        }
        result["status_name"] = STATUS_NAMES.get(
            result["status_code"], f"UNKNOWN_{result['status_code']}"
        )

        # If successful, try getting SSO bearer
        if result["status_code"] == 1:
            try:
                self.refresh_bearer()
                result["bearer_token"] = self.bearer_token
            except Exception:
                pass

        return result

    @staticmethod
    def _extract_grpc_error(content: bytes) -> str:
        """Extract error message from gRPC response."""
        try:
            payload = None
            pos = 0
            while pos < len(content):
                if pos + 5 > len(content):
                    break
                flag = content[pos]
                length = struct.unpack("!I", content[pos + 1 : pos + 5])[0]
                chunk = content[pos + 5 : pos + 5 + length]
                pos += 5 + length
                if flag == 0 and length > 0:
                    payload = chunk
            if payload:
                # Try to find error message - field 10 contains error text
                idx = payload.find(b"\x52")  # field 10, wire 2
                if idx >= 0:
                    pos = idx + 1
                    length = 0
                    shift = 0
                    while True:
                        b = payload[pos]
                        length |= (b & 0x7F) << shift
                        shift += 7
                        pos += 1
                        if not (b & 0x80):
                            break
                    err = payload[pos : pos + length].decode("utf-8", errors="replace")
                    return err
        except Exception:
            pass
        return ""

    # ── Auth ──────────────────────────────────────────────────────────────

    @property
    def is_authenticated(self) -> bool:
        return bool(self.cookies) and bool(self.bearer_token)

    @property
    def _headers(self) -> dict:
        h = dict(self._base_headers)
        h["Authorization"] = f"Bearer {self.bearer_token}"
        return h

    def login_playwright(
        self, username: str, password: str, headless: bool = False
    ) -> dict:
        """Full login via Playwright browser automation.

        Opens accounts.snapchat.com/v2/login, fills credentials,
        waits for redirect to /v2/welcome, then extracts cookies.
        Returns cookies dict.
        """
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                viewport={"width": 1280, "height": 800},
                locale="en-US",
            )
            page = context.new_page()
            page.goto(
                "https://accounts.snapchat.com/v2/login", wait_until="networkidle"
            )
            page.fill("input[name='accountIdentifier']", username)
            page.click("button[type='submit']")
            page.wait_for_selector("input[type='password']", timeout=10000)
            page.fill("input[type='password']", password)
            page.click("button[type='submit']")
            page.wait_for_url("**/v2/welcome**", timeout=30000)
            raw = context.cookies()
            browser.close()

        self.cookies = self._cookies_to_login_dict(raw)
        return self.cookies

    def refresh_bearer(self) -> str:
        """Exchange cookies for a Bearer token via SSO endpoint.

        Posts to accounts.snapchat.com with session cookies.
        The response body IS the Bearer token (292 chars, base64, starts hCgwK...).
        """
        r = requests.post(
            "https://accounts.snapchat.com/accounts/sso",
            params={"client_id": "web-calling-corp--prod"},
            headers={
                "Accept": "text/html,application/json,*/*",
                "Origin": "https://www.snapchat.com",
                "Referer": "https://www.snapchat.com/web",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            cookies=self.cookies,
            impersonate="chrome131",
            timeout=30,
        )
        if r.status_code != 200:
            raise AuthError(f"SSO failed: HTTP {r.status_code}, {r.text[:200]}")
        body = r.text.strip()
        if not body.startswith("hCgwK") or len(body) < 50:
            raise AuthError(f"SSO returned unexpected body: {body[:200]}")
        self.bearer_token = body
        return body

    def load_session(self, cookie_path: str, token_path: str = "") -> None:
        """Load cookies from JSON file and optionally bearer token from text file."""
        with open(cookie_path) as f:
            raw = json.load(f)
        self.cookies = self._cookies_to_login_dict(raw)
        if token_path:
            with open(token_path) as f:
                self.bearer_token = f.read().strip()
        elif self.cookies:
            try:
                self.refresh_bearer()
                print("Bearer token refreshed via SSO")
            except AuthError as e:
                print(f"Could not auto-refresh bearer: {e}")

    def save_session(self, cookie_path: str, token_path: str = "") -> None:
        """Save cookies as a list-of-dicts JSON and bearer token as text."""
        os.makedirs(os.path.dirname(cookie_path) or ".", exist_ok=True)
        out = [
            {"name": k, "value": v, "domain": "snapchat.com"}
            for k, v in self.cookies.items()
        ]
        with open(cookie_path, "w") as f:
            json.dump(out, f, indent=2)
        if token_path and self.bearer_token:
            with open(token_path, "w") as f:
                f.write(self.bearer_token)

    def extract_cookies_cdp(self, port: int = 9222) -> dict:
        """Extract cookies from an already-authenticated Chrome via CDP."""
        import http.client, json as j

        c = http.client.HTTPConnection("localhost", port, timeout=5)
        c.request("GET", "/json")
        pages = j.loads(c.getresponse().read())
        c.close()

        import asyncio, websockets

        target = None
        for p in pages:
            if "snapchat.com/web" in p.get("url", ""):
                target = p["webSocketDebuggerUrl"]
                break
        if not target:
            raise AuthError(
                "No Snapchat page found in CDP. Open https://web.snapchat.com first."
            )

        async def _get():
            async with websockets.connect(target, max_size=2**24) as ws:
                await ws.send(
                    j.dumps({"id": 1, "method": "Network.getAllCookies", "params": {}})
                )
                while True:
                    msg = j.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    if msg.get("id") == 1:
                        return msg["result"]["cookies"]

        raw = asyncio.run(_get())
        self.cookies = self._cookies_to_login_dict(raw)
        return self.cookies

    def extract_cookies_and_bearer_cdp(self, port: int = 9222) -> None:
        """CDP cookie extraction + SSO bearer refresh in one shot."""
        self.extract_cookies_cdp(port)
        self.refresh_bearer()

    # ── Low-level gRPC ──────────────────────────────────────────────────

    def _grpc_call(
        self, url: str, protobuf: bytes, timeout: int = 30
    ) -> requests.Response:
        """Make an authenticated gRPC-web POST request."""
        frame = struct.pack("!BI", 0, len(protobuf)) + protobuf
        r = requests.post(
            url,
            data=frame,
            headers=self._headers,
            cookies=self.cookies,
            impersonate="chrome131",
            timeout=timeout,
        )
        return r

    def _grpc_response_ok(self, resp: requests.Response) -> bool:
        """Check if a gRPC-web response indicates success."""
        if resp.status_code != 200:
            return False
        gs = (
            resp.headers.get("grpc-status") or resp.headers.get("Grpc-Status", "")
        ).strip()
        return gs == "0" or b"grpc-status:0" in resp.content

    def _raise_for_grpc(self, resp: requests.Response, label: str = "") -> None:
        """Raise GrpcError if the response indicates a gRPC error."""
        if resp.status_code == 200 and self._grpc_response_ok(resp):
            return
        gs = resp.headers.get("grpc-status") or resp.headers.get("Grpc-Status", "?")
        gm = resp.headers.get("grpc-message") or resp.headers.get("Grpc-Message", "")
        detail = ""
        if not gs and resp.content:
            idx = resp.content.find(b"grpc-status:")
            if idx >= 0:
                gs = (
                    resp.content[idx : idx + 30]
                    .split(b"\r\n")[0]
                    .decode("latin-1", errors="replace")
                )
        raise GrpcError(
            status=int(gs) if gs.isdigit() else -1,
            message=gm.strip(),
            details=f"{len(resp.content)}B response",
        )

    def _parse_grpc_payload(self, resp: requests.Response) -> bytes:
        """Extract protobuf payload from gRPC-web response (skips frame headers)."""
        payload = b""
        pos = 0
        content = resp.content
        while pos < len(content):
            if pos + 5 > len(content):
                break
            flag = content[pos]
            length = struct.unpack("!I", content[pos + 1 : pos + 5])[0]
            chunk = content[pos + 5 : pos + 5 + length]
            pos += 5 + length
            if flag == 0 and length > 0:
                payload = chunk
        return payload

    # ── Upload Service ──────────────────────────────────────────────────

    def get_upload_location(self) -> dict:
        """Get a pre-signed S3 upload URL and storage refs for media upload.

        Returns: {url, ref1 (23 chars, ends _1), ref2 (22 chars)}
        """
        req = bytes([0x10, 0x01, 0x20, 0x01, 0x3A, 0x01, 0x00, 0x80, 0x01, 0x01])
        r = self._grpc_call(
            "https://web.snapchat.com/snapchat.content.v2.MediaDeliveryService/getUploadLocations",
            req,
        )
        self._raise_for_grpc(r, "getUploadLocations")
        payload = self._parse_grpc_payload(r)
        upload_url = re.search(
            r"https?://[^\x00-\x1f\x7f-\x9f]+", payload.decode("latin-1")
        ).group(0)
        cr = payload.find(b"\x1a\x3b\x0a\x17")
        ref1 = payload[cr + 4 : cr + 4 + 23].decode("utf-8")
        return {"url": upload_url, "ref1": ref1, "ref2": ref1[:21]}

    def encrypt_media(self, filepath: str) -> tuple[bytes, bytes, bytes]:
        """AES-256-CBC encrypt a media file.

        Returns: (key, iv, encrypted_data)
        """
        data = open(filepath, "rb").read()
        key = os.urandom(32)
        iv = os.urandom(16)
        enc = AES.new(key, AES.MODE_CBC, iv).encrypt(pad(data, 16))
        return key, iv, enc

    def upload_media(self, upload_url: str, encrypted_data: bytes) -> None:
        """PUT encrypted bytes to the pre-signed CDN URL."""
        r = requests.put(
            upload_url,
            data=encrypted_data,
            headers={"Content-Type": "application/octet-stream"},
            impersonate="chrome131",
            timeout=60,
        )
        if r.status_code != 200:
            raise SnapchatError(f"Upload failed: HTTP {r.status_code}")

    # ── Template modification ──────────────────────────────────────────

    def _load_template(self) -> bytearray:
        """Load the 0172 template (raw proto body, no gRPC frame header)."""
        if self._template_cache is not None:
            return bytearray(self._template_cache)
        raw = open(TEMPLATE_PATH, "rb").read()
        t = bytearray(raw[5:])  # skip 5-byte gRPC frame header
        self._template_cache = bytearray(t)
        return t

    def _build_media_message(
        self,
        conv_uuid: bytes,
        conv_ref: bytes,
        key: bytes,
        iv: bytes,
        ref1: str,
        ref2: str,
        is_video: bool = False,
        add_media_type: bool = False,
        add_has_audio: bool = False,
        add_mime: bool = False,
    ) -> bytes:
        """Build a CreateContentMessage protobuf from the 0172 template.

        Applies:
          MOD1: CHAT_MEDIA type field (field 2 = 2) at SnapContent value start
          MOD2: SnapMedia extensions (mediaType, hasAudio) after SnapMedia value
          MOD3: mimeType field after MOD2 (SnapMedia-level, not field19 child)

        Offsets are for the post-MOD1 template (587 bytes proto body).
        """
        p = self._load_template()
        conv_ref_template = _decode_uuid("4aa0d3e8-be1d-4538-8faa-1b308440dd4d")

        # ── MOD1: Insert CHAT_MEDIA type field ──
        p[60:60] = bytes([0x10, 0x02])  # field 2 = CHAT_MEDIA (varint=2)
        p[58] = 0xF6  # update SnapContent length LSB (500→502)

        # ── Same-length replacements (post-MOD1 offsets) ──
        # Conv UUID
        p[4:20] = conv_uuid
        idx = p.find(conv_ref_template)
        if idx >= 0:
            p[idx : idx + 16] = conv_ref

        # Storage refs
        for i in range(len(p) - 30):
            try:
                s = p[i : i + 23].decode("ascii")
                if s.endswith("_1") and len(s) == 23:
                    p[i : i + 23] = ref1.encode()
                    p[i + 27 : i + 27 + 21] = ref2.encode()
                    break
            except Exception:
                pass

        # Binary key/IV (post-MOD1 offsets)
        p[178 : 178 + 32] = key
        p[212 : 212 + 16] = iv

        # Base64 key/IV (server uses these)
        b64k = base64.b64encode(key).decode()
        b64i = base64.b64encode(iv).decode()
        p[103 : 103 + 44] = b64k.encode()
        p[149 : 149 + 24] = b64i.encode()

        # ── MOD2+MOD3: SnapMedia extensions ──
        extra = b""
        if add_media_type:
            extra += bytes([0x18, 0x02])  # field 3 = mediaType=2 (VIDEO)
        if add_has_audio:
            extra += bytes([0x20, 0x01])  # field 4 = hasAudio=true
        mime = bytes([0x2A, 0x0A]) + b"video/mp4" if add_mime else b""

        if extra:
            p[173:173] = extra  # after SnapMedia value end
        if mime:
            p[173 + len(extra) : 173 + len(extra)] = mime  # after MOD2

        total_extra = len(extra) + len(mime)
        if total_extra:
            # SnapMedia length field (at p[100])
            p[100] += total_extra
            # All wrapper lengths increase by total_extra
            p[58:60] = _encode_varint(502 + total_extra)  # SnapContent
            p[63:65] = _encode_varint(422 + total_extra)  # field 11 wrapper
            p[66:68] = _encode_varint(419 + total_extra)  # wrapping field
            p[83:85] = _encode_varint(158 + total_extra)  # MRL (MediaReferenceList)
            p[86:88] = _encode_varint(149 + total_extra)  # wrapping field 1
            p[89:91] = _encode_varint(146 + total_extra)  # MediaReference

        return bytes(p)

    # ── Messaging ──────────────────────────────────────────────────────

    def send_text(self, conversation_id: str, text: str) -> dict:
        """Send a text message to a conversation.

        Args:
            conversation_id: Hex UUID (e.g. "6e609ac8-04ed-45b8-9dee-002cdaf13db5")
            text: Message text (plain string)
        Returns: {status, message_id, response_hex}
        """
        conv = _decode_uuid(conversation_id)
        msg_id = int.from_bytes(os.urandom(8), "big") >> 2

        # Build text message proto from scratch
        proto = bytearray()
        # Field 1: conversationId
        proto.extend(bytes([0x0A, 0x12, 0x0A, 0x10]) + conv)
        # Field 2: message ID
        proto.append(0x10)
        proto.extend(_encode_varint(msg_id))
        # Field 3: sender metadata
        proto.extend(
            bytes([0x1A, 0x18, 0x0A, 0x16, 0x0A, 0x12, 0x0A, 0x10])
            + self.MY_UUID
            + bytes([0x10, 0x29])
        )
        # Field 4: text content (PATCHED: varint lengths over UTF-8 bytes)
        def _ld(tag: int, payload: bytes) -> bytes:
            return bytes([tag]) + _encode_varint(len(payload)) + payload

        text_body = _ld(0x0A, text.encode("utf-8"))
        inner_msg = _ld(0x12, text_body)
        inner_field4 = _ld(0x22, inner_msg)
        text_content = bytes([0x10, 0x01]) + inner_field4 + bytes([0x38, 0x02])
        proto.extend(_ld(0x22, text_content))
        # Field 8: conversation reference
        proto.extend(bytes([0x42, 0x14, 0x0A, 0x12, 0x0A, 0x10]) + conv)

        r = self._grpc_call(
            "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage",
            bytes(proto),
        )
        try:
            self._raise_for_grpc(r, "send_text")
            return {
                "status": "ok",
                "message_id": msg_id,
                "response_hex": r.content.hex()[:80],
            }
        except GrpcError as e:
            return {
                "status": "error",
                "error": str(e),
                "response_hex": r.content.hex()[:80],
            }

    def _send_media(
        self,
        conversation_id: str,
        filepath: str,
        conv_ref: Optional[str] = None,
        is_video: bool = False,
        add_media_type: bool = False,
        add_has_audio: bool = False,
        add_mime: bool = False,
    ) -> dict:
        """Internal: upload + send media via 0172 template.

        Args:
            conversation_id: Hex UUID
            filepath: Path to media file
            conv_ref: Conversation ref UUID (defaults to conversation_id)
        Returns: {status, ref1, response_hex}
        """
        conv = _decode_uuid(conversation_id)
        ref = _decode_uuid(conv_ref or conversation_id)

        loc = self.get_upload_location()
        key, iv, enc = self.encrypt_media(filepath)
        self.upload_media(loc["url"], enc)

        proto = self._build_media_message(
            conv_uuid=conv,
            conv_ref=ref,
            key=key,
            iv=iv,
            ref1=loc["ref1"],
            ref2=loc["ref2"],
            is_video=is_video,
            add_media_type=add_media_type,
            add_has_audio=add_has_audio,
            add_mime=add_mime,
        )

        r = self._grpc_call(
            "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage",
            proto,
        )
        try:
            self._raise_for_grpc(r, "send_media")
            return {
                "status": "ok",
                "ref1": loc["ref1"],
                "response_hex": r.content.hex()[:80],
            }
        except GrpcError as e:
            return {
                "status": "error",
                "ref1": loc["ref1"],
                "error": str(e),
                "response_hex": r.content.hex()[:80],
            }

    def send_image(
        self, conversation_id: str, filepath: str, conv_ref: Optional[str] = None
    ) -> dict:
        """Send an image message.

        Uses CHAT_MEDIA content type (not SNAP). The image is encrypted
        with a random AES-256-CBC key and uploaded to Snapchat CDN.
        """
        return self._send_media(conversation_id, filepath, conv_ref=conv_ref)

    def send_video(
        self,
        conversation_id: str,
        filepath: str,
        conv_ref: Optional[str] = None,
        extensions: bool = True,
    ) -> dict:
        """Send a video message.

        Args:
            conversation_id: Hex UUID
            filepath: Path to video file
            conv_ref: Conversation ref UUID (defaults to conversation_id)
            extensions: If True, includes mediaType, hasAudio, and mimeType fields
        """
        return self._send_media(
            conversation_id,
            filepath,
            conv_ref=conv_ref,
            is_video=True,
            add_media_type=extensions,
            add_has_audio=extensions,
            add_mime=extensions,
        )

    def send_media(
        self, conversation_id: str, filepath: str, conv_ref: Optional[str] = None
    ) -> dict:
        """Auto-detect file type and send image or video.

        Detects by file extension (.mp4, .mov, .webm → video; else image).
        """
        ext = os.path.splitext(filepath)[1].lower()
        is_vid = ext in (".mp4", ".mov", ".webm", ".avi", ".mkv")
        if is_vid:
            return self.send_video(conversation_id, filepath, conv_ref=conv_ref)
        else:
            return self.send_image(conversation_id, filepath, conv_ref=conv_ref)

    # ── Data / Sync ─────────────────────────────────────────────────

    def delta_sync(self, conv_uuid: Optional[str] = None) -> bytes:
        """Sync conversation data. Returns raw protobuf payload."""
        ds = bytearray([0x08, 0x44])
        ds.extend(bytes([0x12, 0x12, 0x0A, 0x10]) + self.MY_UUID)
        if conv_uuid:
            ds.extend(bytes([0x22, 0x12, 0x0A, 0x10]) + _decode_uuid(conv_uuid))
        ds.extend([0x38, 0x01])
        r = self._grpc_call(
            "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
            bytes(ds),
        )
        self._raise_for_grpc(r, "delta_sync")
        return self._parse_grpc_payload(r)

    # ── User & Social ───────────────────────────────────────────────

    def lookup_user(self, user_id: str) -> dict:
        """Get public info about a user by their 36-char hex UUID.

        POST com.snapchat.atlas.gw.AtlasGw/GetSnapchatterPublicInfo
        Request: f1=user_UUID_16bytes, f2=varint_1
        """
        uid = _decode_uuid(user_id)
        proto = bytes([0x0A, 0x10]) + uid + bytes([0x10, 0x01])
        r = self._grpc_call(
            "https://web.snapchat.com/com.snapchat.atlas.gw.AtlasGw/GetSnapchatterPublicInfo",
            proto,
        )
        self._raise_for_grpc(r, "lookup_user")
        payload = self._parse_grpc_payload(r)
        result = self._parse_protobuf_fields(payload)
        result["raw"] = payload.hex()
        return result

    def sync_friends(self) -> dict:
        """Sync friend data. Returns friends list as parsed protobuf.

        POST com.snapchat.atlas.gw.AtlasGw/SyncFriendData
        Request: f5=empty(0x2a 0x00)
        """
        proto = bytes([0x2A, 0x00])
        r = self._grpc_call(
            "https://web.snapchat.com/com.snapchat.atlas.gw.AtlasGw/SyncFriendData",
            proto,
        )
        self._raise_for_grpc(r, "sync_friends")
        payload = self._parse_grpc_payload(r)
        return {"raw": payload.hex()}

    def incoming_friend_requests(self) -> dict:
        """Get incoming friend requests.

        POST snapchat.friending.server.FriendRequests/IncomingFriendSync
        Request: empty gRPC frame
        """
        proto = bytes([])
        r = self._grpc_call(
            "https://web.snapchat.com/snapchat.friending.server.FriendRequests/IncomingFriendSync",
            proto,
        )
        self._raise_for_grpc(r, "incoming_friend_requests")
        payload = self._parse_grpc_payload(r)
        return {"raw": payload.hex()}

    def get_groups(self, conversation_id: str) -> dict:
        """Get group info for a conversation.

        POST messagingcoreservice.MessagingCoreService/GetGroups
        Request: f1 = conv_ref submessage (conversation UUID)
        """
        conv = _decode_uuid(conversation_id)
        proto = bytes([0x0A, 0x12, 0x0A, 0x10]) + conv
        r = self._grpc_call(
            "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/GetGroups",
            proto,
        )
        self._raise_for_grpc(r, "get_groups")
        payload = self._parse_grpc_payload(r)
        return {"raw": payload.hex()}

    # ── Stories & Spotlight (Soma Protocol) ──────────────────────────

    # Soma constants
    ORIGIN_SNAPCHAT_WEB = 19
    TRIGGER_APP_OPEN = 1
    OS_WEB = 3
    APPBUILD_PROD = 3
    RESTRICTED = 1
    EXPT_SPOTLIGHT_ALL = 240
    FRIEND_STORIES = 5
    MY_STORIES = 6

    def _soma_post(
        self, url: str, protobuf: bytes, timeout: int = 30
    ) -> requests.Response:
        """Low-level SOMA protocol POST (raw protobuf, no gRPC-web framing).

        Soma endpoints use raw protobuf with Content-Type: application/octet-stream.
        Unlike gRPC-web endpoints, there is NO 5-byte frame header.
        """
        h = {
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/octet-stream",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
            "Origin": "https://web.snapchat.com",
        }
        r = requests.post(
            url,
            data=protobuf,
            headers=h,
            cookies=self.cookies,
            impersonate="chrome131",
            timeout=timeout,
        )
        return r

    def _build_soma_client_info(self, uid: str, locale: str = "en-US") -> bytes:
        """Build oi (ClientInfo) submessage for soma requests."""
        r = bytearray()
        r.append(0x0A)
        r.extend(self._encode_varint(len(uid)))
        r.extend(uid.encode())
        app = bytearray()
        app.append(0x0A)
        app.extend(self._encode_varint(7))
        app.extend(b"13.79.0")
        app.append(0x18)
        app.append(self.OS_WEB)
        app.append(0x28)
        app.append(self.APPBUILD_PROD)
        r.append(0x12)
        r.extend(self._encode_varint(len(app)))
        r.extend(app)
        loc = locale.encode()
        r.append(0x2A)
        r.extend(self._encode_varint(len(loc)))
        r.extend(loc)
        r.append(0xD8)
        r.append(0x01)
        r.append(self.RESTRICTED)  # field 27 = cameosFeatureRestricted
        return bytes(r)

    def _build_soma_request(
        self,
        feed_type: int,
        feed_types: list[int],
        user_id: str = "",
        locale: str = "en-US",
        last_stream_token: bytes = b"",
        last_meta_stream_token: bytes = b"",
    ) -> bytes:
        """Build a BatchStoriesRequest (pi) protobuf for soma endpoints.

        Uses the correct field numbers extracted from the JS bundle:
          f1: requestId (string) = "dweb-XXXXXXXX"
          f2: requestTimestampMs (int64 = varint)
          f3: origin (int32) = ORIGIN_SNAPCHAT_WEB
          f4: clientInfo (submessage, oi)
          f5: trigger (int32) = TRIGGER_APP_OPEN
          f6: lastStreamToken (bytes, optional)
          f12: feedType (int32)
          f15: lastMetaStreamToken (bytes, optional)
          f18: feedTypes (packed repeated int32)
        """
        now_ms = int(time.time() * 1000)
        dweb = f"dweb-{random.randint(0, 0xFFFFFFFF):08x}"
        uid = user_id or _format_uuid(self.MY_UUID)

        p = bytearray()
        # f1: requestId
        dweb_bytes = dweb.encode()
        p.append(0x0A)
        p.extend(self._encode_varint(len(dweb_bytes)))
        p.extend(dweb_bytes)
        # f2: requestTimestampMs
        p.append(0x10)
        p.extend(self._encode_varint(now_ms))
        # f3: origin
        p.append(0x18)
        p.append(self.ORIGIN_SNAPCHAT_WEB)
        # f4: clientInfo
        ci = self._build_soma_client_info(uid, locale)
        p.append(0x22)
        p.extend(self._encode_varint(len(ci)))
        p.extend(ci)
        # f5: trigger
        p.append(0x28)
        p.append(self.TRIGGER_APP_OPEN)
        # f6: lastStreamToken (optional)
        if last_stream_token:
            p.append(0x32)
            p.extend(self._encode_varint(len(last_stream_token)))
            p.extend(last_stream_token)
        # f12: feedType
        p.append(0x60)
        p.extend(self._encode_varint(feed_type))
        # f15: lastMetaStreamToken (optional)
        if last_meta_stream_token:
            p.append(0x7A)
            p.extend(self._encode_varint(len(last_meta_stream_token)))
            p.extend(last_meta_stream_token)
        # f18: feedTypes (packed repeated int32)
        payload = b"".join(self._encode_varint(v) for v in feed_types)
        p.append(0x92)
        p.append(0x01)
        p.extend(self._encode_varint(len(payload)))
        p.extend(payload)

        return bytes(p)

    @staticmethod
    def _parse_feed_metadata(data: bytes, out: dict) -> None:
        """Parse an x (FeedMetadata) submessage."""
        pos = 0
        while pos < len(data) - 1:
            key, pos = _read_varint(data, pos)
            fn = key >> 3
            wt = key & 7
            if wt == 0:
                val, pos = _read_varint(data, pos)
                if fn == 1:
                    out["feed_type"] = val
            elif wt == 2:
                length, pos = _read_varint(data, pos)
                val = data[pos : pos + length]
                pos += length
                if fn == 2:
                    try:
                        out["display_name"] = val.decode("utf-8")
                    except:
                        pass
                elif fn == 3:
                    try:
                        out["logging_key"] = val.decode("utf-8")
                    except:
                        pass

    @staticmethod
    def _extract_urls(data: bytes, urls: list) -> None:
        pos = 0
        while pos < len(data) - 1:
            key, pos = _read_varint(data, pos)
            fn = key >> 3
            wt = key & 7
            if wt == 2:
                length, pos = _read_varint(data, pos)
                val = data[pos : pos + length]
                pos += length
                try:
                    txt = val.decode("utf-8")
                    if txt.startswith("http") and len(txt) > 10:
                        urls.append(txt)
                except:
                    if len(val) > 10:
                        SnapchatClient._extract_urls(val, urls)

    @staticmethod
    def _try_str(data: bytes) -> tuple:
        try:
            t = data.decode("utf-8")
            if all(ord(c) >= 32 for c in t):
                return True, t
        except:
            pass
        return False, ""

    @staticmethod
    def _parse_card_variant(data: bytes) -> dict:
        info = {}
        pos = 0
        while pos < len(data) - 1:
            key, pos = _read_varint(data, pos)
            fn = key >> 3
            wt = key & 7
            if wt == 0:
                val, pos = _read_varint(data, pos)
                info["f{}".format(fn)] = val
            elif wt == 2:
                length, pos = _read_varint(data, pos)
                val = data[pos : pos + length]
                pos += length
                ok, txt = SnapchatClient._try_str(val)
                if fn == 1 and ok:
                    info["display_name"] = txt
                elif fn == 2 and ok:
                    info["user_id"] = txt if "-" in txt and len(txt) == 36 else txt[:60]
                    if txt.startswith("http"):
                        info["media_url"] = txt
                elif fn == 13 and ok:
                    info["thumbnail_url"] = txt
                elif fn == 11 and ok:
                    info["media_type"] = txt
                elif ok:
                    info["f{}".format(fn)] = txt[:80]
                else:
                    info["f{}_bin".format(fn)] = len(val)
                    urls = []
                    SnapchatClient._extract_urls(val, urls)
                    if urls:
                        info["f{}_urls".format(fn)] = urls
                        # Label URLs by content pattern
                        for url in urls:
                            u = url.lower()
                            if "dfiframe" in u or "dffframe" in u:
                                info["frame_thumbnail_url"] = url
                            elif "largethumbnail" in u:
                                info["thumbnail_url"] = url
                            elif "/aps/bolt/" in u:
                                info["profile_image_url"] = url
        return info

    @staticmethod
    def _parse_er(data: bytes) -> dict:
        card = {"story_id": "", "composite_story_id": "", "card_type": 0}
        pos = 0
        while pos < len(data) - 1:
            key, pos = _read_varint(data, pos)
            fn = key >> 3
            wt = key & 7
            if wt == 0:
                val, pos = _read_varint(data, pos)
                if fn in (2, 3, 4, 6, 36, 38, 48, 57):
                    card["card_type"] = fn
            elif wt == 2:
                length, pos = _read_varint(data, pos)
                val = data[pos : pos + length]
                pos += length
                if fn == 1:
                    try:
                        card["story_id"] = val.decode("utf-8")
                    except:
                        pass
                elif fn == 12:
                    p = 0
                    while p < len(val) - 1:
                        k2, p = _read_varint(val, p)
                        f2 = k2 >> 3
                        w2 = k2 & 7
                        if w2 == 2:
                            l2, p = _read_varint(val, p)
                            v2 = val[p : p + l2]
                            p += l2
                            if f2 == 1:
                                try:
                                    card["composite_story_id"] = v2.decode("utf-8")
                                except:
                                    pass
                elif fn == 41:
                    card["content_token"] = val.hex()[:80]
                elif fn in (2, 3, 4, 6, 36, 38, 48, 57):
                    card["card_variant"] = SnapchatClient._parse_card_variant(val)
        return card

    @staticmethod
    def _parse_ki(data: bytes, out: dict) -> None:
        pos = 0
        while pos < len(data) - 1:
            key, pos = _read_varint(data, pos)
            fn = key >> 3
            wt = key & 7
            if wt == 0:
                val, pos = _read_varint(data, pos)
                if fn == 2:
                    out["start_offset"] = val
            elif wt == 2:
                length, pos = _read_varint(data, pos)
                val = data[pos : pos + length]
                pos += length
                if fn == 1:
                    out["stream_token"] = val
                elif fn in (3, 4):
                    card_info = SnapchatClient._parse_er(val)
                    out.setdefault("cards", []).append(card_info)

    @staticmethod
    def _parse_gi(data: bytes, out: dict) -> None:
        pos = 0
        while pos < len(data) - 1:
            key, pos = _read_varint(data, pos)
            fn = key >> 3
            wt = key & 7
            if wt == 0:
                val, pos = _read_varint(data, pos)
                if fn == 9:
                    out["eof"] = bool(val)
                elif fn == 13:
                    out["predicted_session_depth"] = val
                elif fn == 15:
                    out["region"] = val
            elif wt == 2:
                length, pos = _read_varint(data, pos)
                val = data[pos : pos + length]
                pos += length
                if fn == 1:
                    try:
                        out["request_id"] = val.decode("utf-8")
                    except:
                        pass
                elif fn == 2:
                    out["status_raw"] = val.hex()
                elif fn == 3:
                    SnapchatClient._parse_ki(val, out)
                elif fn == 10:
                    SnapchatClient._parse_feed_metadata(val, out)

    @staticmethod
    def _parse_soma_response(data: bytes) -> dict:
        result = {
            "request_id": "",
            "meta_stream_token": b"",
            "stories": [],
            "status": None,
            "region": 0,
        }

        pos = 0
        while pos < len(data) - 1:
            key, pos = _read_varint(data, pos)
            fn = key >> 3
            wt = key & 7
            if wt == 0:
                val, pos = _read_varint(data, pos)
                if fn == 9:
                    result["region"] = val
            elif wt == 2:
                length, pos = _read_varint(data, pos)
                val = data[pos : pos + length]
                pos += length
                if fn == 1:
                    try:
                        result["request_id"] = val.decode("utf-8")
                    except:
                        pass
                elif fn == 2:
                    result["meta_stream_token"] = val
                elif fn == 3:
                    feed_item = {
                        "request_id": "",
                        "status": None,
                        "eof": False,
                        "feed_type": 0,
                        "display_name": "",
                        "logging_key": "",
                        "stream_token": b"",
                        "start_offset": 0,
                        "cards": [],
                        "region": 0,
                    }
                    SnapchatClient._parse_gi(val, feed_item)
                    result["stories"].append(feed_item)
                elif fn == 6:
                    result["status"] = val.hex()
        return result

    def get_spotlight_feed(
        self, page_size: int = 30, page_token: bytes = b"", locale: str = "en-US"
    ) -> dict:
        """Fetch the Spotlight feed.

        Uses the soma protocol (raw protobuf POST, no gRPC framing).
        Returns parsed response with stories, metaStreamToken for pagination.

        Args:
            page_size: Number of stories to request (default 30)
            page_token: metaStreamToken from previous response for pagination
            locale: Locale string

        Returns: dict with keys: request_id, meta_stream_token, stories (list of feed items),
                 status, region
        """
        body = self._build_soma_request(
            feed_type=self.EXPT_SPOTLIGHT_ALL,
            feed_types=[self.EXPT_SPOTLIGHT_ALL],
            locale=locale,
            last_meta_stream_token=page_token,
        )
        r = self._soma_post(
            "https://web.snapchat.com/df-spotlight-prod/batch_stories",
            body,
        )
        if r.status_code != 200:
            return {
                "status": "error",
                "http_status": r.status_code,
                "raw": r.content.hex()[:200],
            }
        return self._parse_soma_response(r.content)

    def get_stories_feed(
        self, page_size: int = 30, page_token: bytes = b"", locale: str = "en-US"
    ) -> dict:
        """Fetch the Stories feed from mixer (Friend Stories + My Stories).

        Uses the soma protocol (raw protobuf POST, no gRPC framing).

        Args:
            page_size: Number of stories to request
            page_token: metaStreamToken for pagination
            locale: Locale string

        Returns: dict with parsed response
        """
        body = self._build_soma_request(
            feed_type=self.FRIEND_STORIES,
            feed_types=[self.FRIEND_STORIES, self.MY_STORIES],
            locale=locale,
            last_meta_stream_token=page_token,
        )
        r = self._soma_post(
            "https://web.snapchat.com/df-mixer-prod/soma/batch_stories",
            body,
        )
        if r.status_code != 200:
            return {
                "status": "error",
                "http_status": r.status_code,
                "raw": r.content.hex()[:200],
            }
        return self._parse_soma_response(r.content)

    def get_spotlight_context(self, entry_point: str = "web_stories_request") -> dict:
        """Get Spotlight context (lens/sound configuration).

        NOTE: The context.spotlight endpoint no longer exists (returns SPA HTML).
        This method is deprecated and needs a fresh browser capture to identify
        the correct endpoint and protobuf structure.
        """
        raise NotImplementedError(
            "get_spotlight_context endpoint (context.spotlight) no longer exists. "
            "Needs fresh browser capture to identify the current endpoint."
        )

    # ── View History ────────────────────────────────────────────────

    def mark_viewed(self, conversation_id: str, content_id_hex: str = "") -> dict:
        """Mark content as viewed (read receipt).

        POST readreceipt-server/viewhistory (soma-style raw protobuf)
        Proto structure (from browser captures):
          f1: requestId (string)
          f2: timestampMs (int64 varint)
          f3: int32 = 1
          f4: target submessage (20 bytes):
            f1: targetId submessage (18 bytes):
              f1: fixed64 uuid_high
              f2: fixed64 uuid_low
          f5: bytes [0x01, 0x02]  (at TOP LEVEL, not inside f4)

        Response: f1=requestId (echo)
        """
        ts = int(time.time() * 1000)
        sid = f"dweb-{os.urandom(4).hex()[:8]}"
        conv = _decode_uuid(conversation_id)

        uuid_high = int.from_bytes(conv[:8], "big")
        uuid_low = int.from_bytes(conv[8:16], "big")

        target_id = bytearray()
        target_id.append(0x09)
        target_id.extend(uuid_high.to_bytes(8, "little"))
        target_id.append(0x11)
        target_id.extend(uuid_low.to_bytes(8, "little"))

        content_target = bytearray()
        content_target.append(0x0A)
        content_target.extend(_encode_varint(len(target_id)))
        content_target.extend(target_id)

        p = bytearray()
        p.append(0x0A)
        p.extend(_encode_varint(len(sid)))
        p.extend(sid.encode())
        p.append(0x10)
        p.extend(_encode_varint(ts))
        p.extend([0x18, 0x01])
        p.append(0x22)
        p.extend(_encode_varint(len(content_target)))
        p.extend(content_target)
        p.extend([0x2A, 0x02, 0x01, 0x02])

        r = self._soma_post(
            "https://web.snapchat.com/readreceipt-server/viewhistory", bytes(p)
        )
        if r.status_code != 200:
            return {
                "status": "error",
                "http_status": r.status_code,
                "body": r.content.decode("utf-8", errors="replace")[:200],
            }
        return {"raw": r.content.hex()}

    def get_messages(self, conversation_id: str, limit: int = 50, data: Optional[bytes] = None) -> list:
        """Get text messages for a conversation out of DeltaSync data, newest first.

        PATCHED. Upstream collapsed repeated texts, dropped anything shorter than 4 characters or without a
        space ("hi", "ok", "hello"), and only guessed at what was text. Now:
          * a string at path ..4/4/2/1 is a message text (the same shape send_text builds); any length counts
          * other printable strings still count if they look like prose (the old heuristic)
          * identical texts are kept separately (deduped by byte offset, not by content)
        Returns: list of {text, sender ("me"|"other")}
        """
        if data is None:  # callers that check many chats pass one shared sync
            ds_data = self.delta_sync()
            data = (
                ds_data
                if isinstance(ds_data, bytes)
                else bytes.fromhex(ds_data.get("raw", ""))
            )
        if not data or len(data) < 16:
            return []

        conv_bytes = _decode_uuid(conversation_id)
        my_bytes = self.MY_UUID
        TEXT_PATH = (4, 4, 2, 1)

        def _printable(t: str) -> bool:
            return bool(t) and all(c.isprintable() or c in "\n\t" for c in t)

        def _walk(buf, base, depth, path, out):
            pos = 0
            while pos < len(buf):
                try:
                    key, pos = _read_varint(buf, pos)
                except Exception:
                    return
                fn, wt = key >> 3, key & 7
                if wt == 0:
                    try:
                        _, pos = _read_varint(buf, pos)
                    except Exception:
                        return
                elif wt == 2:
                    try:
                        length, pos = _read_varint(buf, pos)
                    except Exception:
                        return
                    if length < 0 or pos + length > len(buf):
                        return
                    val = buf[pos : pos + length]
                    start = base + pos
                    pos += length
                    try:
                        t = val.decode("utf-8")
                    except UnicodeDecodeError:
                        t = ""
                    if t and _printable(t):
                        if (path + (fn,))[-4:] == TEXT_PATH and len(t) <= 2000 and not UUID_TEXT.match(t.strip()):
                            out.append((start, t.strip(), True))
                        elif 3 < len(t) < 300 and " " in t and not t.startswith("http"):
                            if sum(c.isalpha() for c in t) >= len(t) * 0.2:
                                out.append((start, t.strip(), False))
                    elif length >= 2 and depth < 8:   # a one-word message sits in a 4-byte container
                        _walk(val, start, depth + 1, path + (fn,), out)
                elif wt == 1:
                    pos += 8
                elif wt == 5:
                    pos += 4
                else:
                    return

        messages, seen_offsets = [], set()
        pos = len(data)
        while pos > 0 and len(messages) < limit:
            idx = data.rfind(conv_bytes, 0, pos)
            if idx == -1:
                break
            # PATCHED: look only inside this record (up to the next mention of the chat), so a neighbouring
            # message of ours is never taken as the sender of this one.
            nxt = data.find(conv_bytes, idx + 16)
            end = min(nxt if nxt != -1 else len(data), idx + 500)
            sender = "me" if (my_bytes and my_bytes in data[idx:end]) else "other"
            found = []
            _walk(data[idx + 16 : end], idx + 16, 0, (), found)
            in_record = set()
            for off, t, structural in found:
                if off in seen_offsets or not t or t in in_record:
                    continue                    # same bytes, or the same text twice inside ONE record
                seen_offsets.add(off)
                in_record.add(t)
                if not structural and len(t) < 4:
                    continue
                messages.append({"text": t, "sender": sender})   # separate records stay separate messages
            pos = idx
        return messages[:limit]

    # ── Message Queries ─────────────────────────────────────────────

    def query_messages(
        self, conversation_id: str, limit: int = 100, sync_token: Optional[bytes] = None
    ) -> dict:
        """Get message history for a conversation.

        POST messagingcoreservice.MessagingCoreService/QueryMessages
        NOTE: Returns PERMISSION_DENIED (grpc-status=7) for all client auth —
        method exists but may require server-to-server auth or admin scope.
        """
        conv = _decode_uuid(conversation_id)
        conv_ref = bytes([0x0A, 0x10]) + conv
        user_ref = bytes([0x0A, 0x10]) + self.MY_UUID

        p = bytearray()
        p.extend([0x08, 0x07])
        p.append(0x12)
        p.extend(_encode_varint(len(conv_ref)))
        p.extend(conv_ref)
        p.append(0x18)
        p.extend(_encode_varint(limit))
        p.append(0x22)
        p.extend(_encode_varint(len(user_ref)))
        p.extend(user_ref)

        if sync_token:
            p.append(0x2A)
            p.extend(_encode_varint(len(sync_token)))
            p.extend(sync_token)

        r = self._grpc_call(
            "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/QueryMessages",
            bytes(p),
        )
        self._raise_for_grpc(r, "query_messages")
        payload = self._parse_grpc_payload(r)
        return {"raw": payload.hex(), "note": "PERMISSION_DENIED — method restricted"}

    def query_conversation(
        self,
        conversation_id: str,
        max_messages: int = 40,
        max_timestamp: Optional[int] = None,
        sync_token: Optional[bytes] = None,
    ) -> dict:
        """Get conversation history with pagination.

        POST messagingcoreservice.MessagingCoreService/QueryConversations
        """
        conv = _decode_uuid(conversation_id)
        conv_ref = bytes([0x0A, 0x10]) + conv

        pagination = bytearray()
        pagination.append(0x0A)
        if sync_token:
            pagination.extend(_encode_varint(len(sync_token) + 1))
            pagination.extend([0x0A] + _encode_varint(len(sync_token)))
            pagination.extend(sync_token)
        else:
            pagination.append(0x07)
            pagination.extend(
                _encode_varint(ts if (ts := max_timestamp) else int(time.time() * 1000))
            )
        pagination.append(0x20)
        pagination.append(0x01)
        pagination.append(0x38)
        pagination.append(0x01)

        p = bytearray()
        p.append(0x0A)
        p.extend(_encode_varint(len(conv_ref)))
        p.extend(conv_ref)
        p.append(0x18)
        p.extend(_encode_varint(max_messages))
        p.append(0x2A)
        p.extend(_encode_varint(len(pagination)))
        p.extend(pagination)

        r = self._grpc_call(
            "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/QueryConversations",
            bytes(p),
        )
        self._raise_for_grpc(r, "query_conversation")
        payload = self._parse_grpc_payload(r)
        return {"raw": payload.hex()}

    def sync_conversations(self) -> dict:
        """Sync all conversations.

        POST messagingcoreservice.MessagingCoreService/SyncConversations
        """
        conv = _decode_uuid("6e609ac8-04ed-45b8-9dee-002cdaf13db5")
        conv_ref = bytes([0x0A, 0x10]) + conv

        p = bytearray()
        p.append(0x0A)
        p.extend(_encode_varint(len(conv_ref)))
        p.extend(conv_ref)
        p.append(0x12)
        p.append(0x05)
        p.extend(b"useV4")
        p.extend([0x22, 0x00, 0x28, 0x01])

        r = self._grpc_call(
            "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/SyncConversations",
            bytes(p),
        )
        self._raise_for_grpc(r, "sync_conversations")
        payload = self._parse_grpc_payload(r)
        return {"raw": payload.hex()}

    # ── Media Download ─────────────────────────────────────────────

    def download_media(self, url: str, filepath: str = "") -> dict:
        """Download media from a Snapchat CDN URL.

        bolt-gcdn.sc-cdn.net and cf-st.sc-cdn.net URLs are publicly
        accessible (no auth needed). Extracts filename from URL or
        content-type if no filepath given.

        Args:
            url: CDN URL (from card_variant thumbnail_url/media_url)
            filepath: Optional save path (auto-generated if empty)

        Returns: dict with keys: filepath, size, content_type, url
        """
        r = requests.get(url, stream=True, timeout=30, impersonate="chrome131")
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}", "url": url}

        ct = r.headers.get("content-type", "")
        ext_map = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "video/mp4": ".mp4",
            "video/webm": ".webm",
            "application/octet-stream": ".bin",
        }
        ext = ext_map.get(ct.split(";")[0], ".bin")

        if not filepath:
            name = url.split("/")[-1].split("?")[0]
            if not name or len(name) > 50:
                name = f"snap_{int(time.time())}"
            # avoid double extension
            if not name.lower().endswith(ext):
                name += ext
            filepath = os.path.join(OUT, name)

        os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)
        with open(filepath, "wb") as f:
            for chunk in r.iter_content(65536):
                f.write(chunk)

        return {
            "filepath": filepath,
            "size": os.path.getsize(filepath),
            "content_type": ct,
            "url": url,
        }

    # ── Missing Features (need fresh captures) ──────────────────────

    def add_friend(
        self, user_id: str, source: int = 0, page: str = "ADD_FRIENDS_PAGE"
    ) -> dict:
        """Send a friend request via FriendAction.AddFriends.

        Args:
            user_id: Target user UUID (36-char hex).
            source: FriendAddSource enum (default 0 = UNKNOWN).
            page: Source page context (default "ADD_FRIENDS_PAGE").

        Returns:
            dict with keys: success (bool), message (str),
            successes (list of str UUIDs), failures (list of dicts).
        """
        import secrets

        uid_bytes = _decode_uuid(user_id)

        def _uuid_submessage(uid_16: bytes) -> bytes:
            u = uuid_mod.UUID(bytes=uid_16)
            high = u.int >> 64
            low = u.int & ((1 << 64) - 1)
            return (
                struct.pack("!B", 0x09)
                + struct.pack("<Q", high)
                + struct.pack("!B", 0x11)
                + struct.pack("<Q", low)
            )

        def _tz_proto(friend_uid: bytes, src: int) -> bytes:
            buf = bytearray()
            uid_sub = _uuid_submessage(friend_uid)
            buf.append(0x0A)
            buf.extend(_encode_varint(len(uid_sub)))
            buf.extend(uid_sub)
            if src:
                buf.append(0x10)
                buf.extend(_encode_varint(src))
            return bytes(buf)

        buf = bytearray()
        buf.append(0x0A)
        buf.extend(_encode_varint(len(page)))
        buf.extend(page.encode())
        tz = _tz_proto(uid_bytes, source)
        buf.append(0x12)
        buf.extend(_encode_varint(len(tz)))
        buf.extend(tz)
        psid = secrets.token_hex(16)
        buf.append(0x1A)
        buf.extend(_encode_varint(len(psid)))
        buf.extend(psid.encode())
        csid = secrets.token_hex(8)
        buf.append(0x2A)
        buf.extend(_encode_varint(len(csid)))
        buf.extend(csid.encode())

        r = self._grpc_call(
            "https://web.snapchat.com/snapchat.friending.server.FriendAction/AddFriends",
            bytes(buf),
        )
        if not self._grpc_response_ok(r):
            self._raise_for_grpc(r, "add_friend")

        payload = self._parse_grpc_payload(r)

        def _parse_uuid_sub(data: bytes) -> str:
            high = low = 0
            p = 0
            while p < len(data):
                t = data[p]
                p += 1
                if (t & 7) == 1:
                    v = struct.unpack("<Q", data[p : p + 8])[0]
                    p += 8
                    if (t >> 3) == 1:
                        high = v
                    else:
                        low = v
            return str(uuid_mod.UUID(int=(high << 64) | low))

        successes = []
        failures = []
        message = ""
        pos = 0
        while pos < len(payload):
            tag = payload[pos]
            pos += 1
            fn = tag >> 3
            wt = tag & 7
            if wt == 2:
                length, pos = _read_varint(payload, pos)
                raw = payload[pos : pos + length]
                pos += length
                if fn == 3:
                    message = raw.decode("utf-8", errors="replace")
                elif fn == 1:
                    successes.append(_parse_uuid_sub(raw))
                elif fn == 2:
                    f_uid = ""
                    f_reason = 0
                    p2 = 0
                    while p2 < len(raw):
                        t2 = raw[p2]
                        p2 += 1
                        fn2 = t2 >> 3
                        wt2 = t2 & 7
                        if wt2 == 2:
                            l2, p2 = _read_varint(raw, p2)
                            if fn2 == 1:
                                f_uid = _parse_uuid_sub(raw[p2 : p2 + l2])
                            p2 += l2
                        elif wt2 == 0:
                            f_reason, p2 = _read_varint(raw, p2)
                    failures.append({"friend_id": f_uid, "reason": f_reason})

        return {
            "success": not failures and len(successes) > 0,
            "message": message,
            "successes": successes,
            "failures": failures,
        }

    def follow_user(self, user_id: str) -> dict:
        """Follow a user's public content.

        NOTE: No dedicated gRPC endpoint for "Follow" was found in the webpack
        bundle analysis across all 1489 modules. Snapchat Web likely handles
        Follow through the DUPLEX/WebSocket CRDT system (same as Like/Comment).

        As a workaround, this calls AddFriends (which may act as a follow on
        public profiles) and CheckActionEligibility to probe follow status.

        Requires browser-based WebSocket capture to discover the exact
        DUPLEX message format for Follow operations.
        """
        # Try AddFriends as a proxy for follow (public profile follow != add friend)
        raise NotImplementedError(
            "follow_user() requires DUPLEX/WebSocket capture. "
            "No gRPC endpoint exists for 'Follow' in webpack bundle (1489 modules analyzed). "
            "Like, Comment, and Follow all go through the DUPLEX CRDT system, not gRPC-web."
        )

    def like_content(self, content_id: str) -> dict:
        """Like a spotlight/story post.

        NOTE: No gRPC endpoint for 'Like' exists across all 1489 webpack modules.
        Like operations go through the DUPLEX/WebSocket CRDT system
        (same transport as messaging: `http://pcs.snap/send-transient-message`).

        Requires capturing the WebSocket frames from the `messaging-wasm-worker`
        browser worker while performing a like action in the Snapchat SPA.
        """
        raise NotImplementedError(
            "like_content() requires DUPLEX/WebSocket capture. "
            "No LikeService found in webpack. Like uses the DUPLEX CRDT system "
            "over WebSocket (http://pcs.snap/send-transient-message). "
            "Use CDP to attach to 'messaging-wasm-worker' and intercept WS frames."
        )

    def comment_on_content(self, content_id: str, text: str) -> dict:
        """Comment on a story/spotlight post.

        NOTE: No gRPC endpoint for 'Comment' exists across all 1489 webpack modules.
        Comment operations go through the DUPLEX/WebSocket CRDT system
        (same transport as messaging: `http://pcs.snap/send-transient-message`).

        Requires capturing the WebSocket frames from the `messaging-wasm-worker`
        browser worker while posting a comment in the Snapchat SPA.
        """
        raise NotImplementedError(
            "comment_on_content() requires DUPLEX/WebSocket capture. "
            "No CommentService found in webpack. Comment uses the DUPLEX CRDT system "
            "over WebSocket (http://pcs.snap/send-transient-message). "
            "Use CDP to attach to 'messaging-wasm-worker' and intercept WS frames."
        )

    def post_story(self, filepath: str, media_type: str = "image") -> dict:
        """Post a story (not yet implemented).

        NOTE: No explicit PostStory/CreateStory gRPC endpoint was found in the
        webpack bundle. Story posting likely uses:
        1. getUploadLocations (MediaDeliveryService) — already implemented
        2. Upload encrypted media to CDN — already implemented
        3. claimContent or batchIngestContent (MediaDeliveryService) to register
        the uploaded content for story use
        4. Or possibly a different DUPLEX/CRDT message

        Requires capturing the browser network traffic while clicking
        'Add to Story' in the Snapchat SPA to identify the exact flow.
        """
        raise NotImplementedError(
            "post_story() requires new Playwright or CDP capture. "
            "Open https://web.snapchat.com, log in, click 'Add to Story' on a media item, "
            "intercept the subsequent gRPC or DUPLEX requests. "
            "Likely uses MediaDeliveryService (claimContent/batchIngestContent) or DUPLEX."
        )

    # ── Utilities ───────────────────────────────────────────────────

    @staticmethod
    def _parse_protobuf_fields(data: bytes) -> dict:
        """Parse top-level protobuf fields into a dict."""
        fields = {}
        pos = 0
        while pos < len(data) - 1:
            tag = data[pos]
            pos += 1
            fn = tag >> 3
            wt = tag & 7
            if wt == 0:
                v = 0
                shift = 0
                while True:
                    b = data[pos]
                    v |= (b & 0x7F) << shift
                    shift += 7
                    pos += 1
                    if not (b & 0x80):
                        break
                fields.setdefault(fn, []).append(("varint", v))
            elif wt == 2:
                length = 0
                shift = 0
                while True:
                    b = data[pos]
                    length |= (b & 0x7F) << shift
                    shift += 7
                    pos += 1
                    if not (b & 0x80):
                        break
                val = data[pos : pos + length]
                pos += length
                fields.setdefault(fn, []).append(("bytes", val.hex()))
            else:
                break
        return fields

    @staticmethod
    def _cookies_to_login_dict(raw: list) -> dict:
        """Convert a list of cookie dicts to a simple key-value dict for curl_cffi."""
        d = {}
        for c in raw:
            name = c.get("name", "")
            val = c.get("value", "")
            if val and "snapchat" in c.get("domain", ""):
                d[name] = val
        return d


def _demo_text():
    """Example: send a text message."""
    client = SnapchatClient()
    client.load_session(
        os.path.join(OUT, "auth_capture", "cookies_fresh.json"),
        os.path.join(OUT, "auth_capture", "token_fresh.txt"),
    )
    result = client.send_text(
        "6e609ac8-04ed-45b8-9dee-002cdaf13db5", "Hello from SnapchatClient!"
    )
    print(f"Text send: {result}")


def _demo_image():
    """Example: send an image."""
    client = SnapchatClient()
    client.load_session(
        os.path.join(OUT, "auth_capture", "cookies_fresh.json"),
        os.path.join(OUT, "auth_capture", "token_fresh.txt"),
    )
    result = client.send_image(
        "6e609ac8-04ed-45b8-9dee-002cdaf13db5", os.path.join(OUT, "test_send_image.jpg")
    )
    print(f"Image send: {result}")


def _demo_video():
    """Example: send a video."""
    client = SnapchatClient()
    client.load_session(
        os.path.join(OUT, "auth_capture", "cookies_fresh.json"),
        os.path.join(OUT, "auth_capture", "token_fresh.txt"),
    )
    result = client.send_video(
        "6e609ac8-04ed-45b8-9dee-002cdaf13db5", os.path.join(OUT, "test_video_h264.mp4")
    )
    print(f"Video send: {result}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "text":
        _demo_text()
    elif len(sys.argv) > 1 and sys.argv[1] == "image":
        _demo_image()
    elif len(sys.argv) > 1 and sys.argv[1] == "video":
        _demo_video()
    else:
        print("Usage: snapclient.py <text|image|video>")
        print("  text  - send a text message")
        print("  image - send an image")
        print("  video - send a video")
