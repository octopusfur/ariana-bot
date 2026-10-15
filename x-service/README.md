# X service

Gives Ariana the X (Twitter) account through the **official X API**, using X's own
[xmcp](https://github.com/xdevplatform/xmcp) server. It is a separate service from
the bot so a crash or a restart on either side never touches the other.

```
Ariana (bot)  ──X-Api-Key──▶  X service (this folder)  ──OAuth1──▶  api.x.com
 social/x_engine.js            app.py → xmcp @ pinned commit
```

## It does nothing until it is asked

No timers, no polling, no keep-alive, no cron. The bot only contacts it when Ariana
actually uses an X tool during a conversation, or when you press **Connect** in the
dashboard. Opening the dashboard, boot, and the status checks never touch it.

On a Render plan that spins idle services down, that request is what wakes it. The
first action after a quiet spell takes longer (the service has to boot and fetch X's
API spec); the bot waits up to ~2½ minutes for that. **Do not add an uptime monitor or a
cron ping** — that is exactly the thing this setup avoids. On an always-on paid plan
there is nothing to wake and the delay never happens.

## What it changes in xmcp, and why

xmcp is downloaded at build time (pinned commit, see the `Dockerfile`) and wrapped by
`app.py`; nothing upstream is edited (it also ships without a licence file, so it is
not copied into this repo). Three things are different from running xmcp on a laptop:

| xmcp as shipped | Here |
|---|---|
| Opens a browser for OAuth at startup | Uses the four OAuth values from environment variables |
| `/mcp` has no authentication | Every request needs `X-Api-Key` (constant-time check); `/healthz` is open but touches nothing |
| No allowlist = **every** X API tool (deletes, blocks…) | No allowlist = the 8 tools Ariana uses (below) |

Tools loaded by default: `getUsersMe`, `getUsersByUsername`, `createPosts`, `likePost`,
`repostPost`, `followUser`, `unfollowUser`, `createDirectMessagesByParticipantId`.
Override with `X_API_TOOL_ALLOWLIST` (comma-separated operation IDs) — but the bot only
knows how to call these eight.

## Setup

**1. X developer portal** — create (or open) an app and:
- set **App permissions to "Read and write"** (add *Direct Message* permission too if she should DM);
- generate the **API Key and Secret** (consumer) and the **Access Token and Secret** *for the
  Ariana account*. Generate the access token **after** changing permissions — tokens made
  earlier stay read-only.
- Check X's current API plan/credits: posting and other writes are not free, and a plan or
  credit problem shows up as a 402/403 in the bot's activity log.

**2. Render** — New → Web Service → this repo:
- Runtime **Docker**, Root Directory **`x-service`**
- Leave **Health Check Path empty** (don't have Render poll it)
- Environment variables:

| Variable | Value |
|---|---|
| `X_OAUTH_CONSUMER_KEY` | API Key |
| `X_OAUTH_CONSUMER_SECRET` | API Key Secret |
| `X_OAUTH_ACCESS_TOKEN` | Access Token (Ariana's account) |
| `X_OAUTH_ACCESS_TOKEN_SECRET` | Access Token Secret |
| `X_SERVICE_API_KEY` | a long random string, 24+ characters (e.g. `openssl rand -hex 32`) |

Memory: roughly 150–300 MB, so the smallest paid size is enough.
The bearer token xmcp's README mentions is **not** needed here.

**3. The bot** — set on the bot's Render service:
```
X_SERVICE_URL=https://<your-x-service>.onrender.com
X_SERVICE_API_KEY=<the same key>
```
Then in the dashboard add the account (platform **X**, handle = the Ariana account),
press **Connect** (first press wakes the service — give it a minute), then enable Actions.
Connect checks the key, the X credentials, that the tools match, and that the service is
signed in as the handle you entered.

## Safety properties worth knowing

- One service = one X account. If the account the service is signed in as is not the
  account Ariana was told to use, the action is refused and nothing is sent.
- A write (post, reply, follow, DM…) is sent once and never retried. If it times out the
  bot says it *may* have gone through — check X before retrying.
- The bot's existing guards still apply in front of this: per-action limits, creator
  confirmation for publishing and unfollowing, batch caps, dry-run.

## Try it with no X account

```
pip install -r requirements.txt
XMCP_DIR=/path/to/xmcp-checkout python tests/dev_server.py
```
starts the service against a fake X API and prints the `X_SERVICE_URL` / `X_SERVICE_API_KEY`
to point a local bot at. Tests: `XMCP_DIR=… python -m unittest discover -s tests -v`.

## Updating

Change `XMCP_COMMIT` in the `Dockerfile`, run the tests against that commit, redeploy.
`fastmcp` is pinned in `requirements.txt` because xmcp passes it an `httpx` client that
FastMCP 4.x already marks deprecated — upgrade it deliberately, with the tests.
