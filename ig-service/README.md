# Ariana's Instagram service

instagrapi (Instagram's private mobile API) behind a small authenticated HTTP API. **No browser** —
plain Python, so it is light: measured at about 66 MB resident when running and idle (before its first
Instagram request); expect somewhat more once it has a live session. Ariana talks to it through `social/ig_engine.js`.

It is only contacted when an action runs or you press **Connect** in the dashboard. Nothing polls it.

## Deploy (Render, Docker runtime)

1. New Web Service → this repo → **Root Directory `ig-service`** → Docker.
2. Environment variables on the service:

| Variable | Required | What |
|---|---|---|
| `IG_SERVICE_API_KEY` | yes | 24+ random characters. Same value goes on Ariana. |
| `IG_USERNAME` | yes | The only account this service may act as (no `@`). |
| `IG_SESSIONID` | yes* | The account's `sessionid` cookie. No password is ever used. |
| `IG_SETTINGS_B64` | alt* | Base64 of instagrapi settings JSON, instead of `IG_SESSIONID`. |
| `IG_PROXY` | strongly advised | e.g. `http://user:pass@host:port` — a **residential or mobile** proxy. A datacenter IP (Render) is the biggest reason accounts get flagged. |
| `IG_DEVICE_SEED` | optional | Any string. Keeps the same device identity across restarts (defaults to the username). |
| `IG_COUNTRY`, `IG_LOCALE`, `IG_UTC_OFFSET_MIN` | optional | Match the proxy's country/locale/timezone, e.g. `NG`, `en_NG`, `60`. |
| `IG_ACTIVE_HOURS` | optional | e.g. `8-23` (local, uses `IG_UTC_OFFSET_MIN`). Writes outside it are refused. |
| `IG_DAILY_LIKES` / `_COMMENTS` / `_FOLLOWS` / `_UNFOLLOWS` / `_DMS` | optional | Defaults 60 / 15 / 20 / 20 / 15 per 24h. |
| `IG_MIN_GAP_S`, `IG_MAX_GAP_S` | optional | Random gap between write actions. Defaults 25–75. |
| `IG_COOLDOWN_HOURS` | optional | Writes pause this long after a challenge / restriction. Default 6. |

3. On Ariana's service set `IG_SERVICE_URL` (the Render URL) and `IG_SERVICE_API_KEY`.
4. Dashboard → Social → add the Instagram account → **Connect** (first one can take ~1 min while the
   service wakes) → enable Actions.

### Getting `IG_SESSIONID` from your phone
Log in to instagram.com in a desktop-mode browser, open its developer tools / cookie viewer, copy the
`sessionid` cookie value. Log in **once, from the same proxy/country** the service will use if you can.
Treat it like a password.

## What she can do
View profile · view an account's recent posts · view her home feed · like · comment · follow / unfollow
· send a DM · read her latest DMs · check follower counts.
**Not supported:** keyword search, posting (needs an image/video), replying to one specific comment,
reposting, notifications, deleting.

## How it keeps her human — and what it can't promise
- One action at a time; random pauses between requests; she *looks first* (opens the post before liking,
  the profile before following); typing time scales with comment/DM length.
- Random gaps between writes, daily caps per action type, optional active hours.
- Stable device identity across restarts.
- If Instagram pushes back (challenge, `feedback_required`, rate limit) every **write** is refused for the
  cool-down; reads still work. Pushing through is how accounts get restricted.
- Instagram can still flag or restrict an account that behaves automatically. Use a proxy, keep caps low,
  and expect to refresh `IG_SESSIONID` now and then. Automation may also be against Instagram's terms.
- Counters are in memory: a restart resets the daily caps. Ariana's own guards keep a persistent count.

## Tests
```
cd ig-service && pip install -r requirements.txt && python -m unittest discover -s tests -v
```
