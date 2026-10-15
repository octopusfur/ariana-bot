Vendored from etrnkz/snapchat-unofficial-api (MIT, see LICENSE.snapchat-unofficial-api). Changes:
- Removed `verify=False` everywhere: upstream disabled TLS verification on calls that carry the session and bearer token.
- `MY_UUID` was the original author's account id, hardcoded. It is now per-instance via `SnapchatClient(my_uuid=...)` and empty by default.
- `send_text` used single-byte lengths over `len(str)`, which corrupted messages over 127 bytes and any non-ASCII text. Now varint lengths over UTF-8 bytes.
- `get_messages` only accepted ASCII; now accepts printable UTF-8.
- Removed the CLI (`__main__.py`) and the Playwright dependency; sign-in is pure HTTP or a pasted session.
