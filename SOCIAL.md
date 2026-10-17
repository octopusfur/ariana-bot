# Ariana — Social Action Layer (X)

Ariana can operate a real X (Twitter) account — **no paid X API, no browser, no extra service.**
Not a dashboard that automates things for you: **she** decides what to do, and this layer gives her hands to do it.

```
Ariana's brain  (engine_v2 prompt, memory, mood, attraction, boundaries — unchanged)
      │  tool calls: social_like / social_comment / social_follow / social_dm / social_post …
      ▼
Social action tools  (social/)
      │  capability check → creator permission → limits → confirmation → activity log
      ▼
Built-in X engine  (social/x_engine.js — in-process, plain HTTP, no browser)
      │  signs in with the server's X credentials; the session is encrypted into Supabase
      ▼
X  (x.com's own web endpoints, via a vendored HTTP client — see vendor/xactions/NOTICE.md)
```

Nothing here replaces her identity, personality, memory, emotional state, attraction system, wants, boundaries or
creator configuration. There is no second AI: the same brain that talks to people decides when to act.

> **What changed.** The previous engines (a Playwright service, then a paid Browser Use cloud browser) are gone.
> Instagram and LinkedIn actions went with them: the built-in engine supports X only. Instagram *publishing* still
> works through its own Graph-API module (`instagram_publish.js`), which was never part of this layer.

---

## 1. What is actually supported

Source of truth: `social/capabilities.json`. The dashboard and the tool list are generated from it, so the feature
cannot claim more than the engine can do.

| Action | Works on X | Backed by |
|---|---|---|
| view profile / engagement counts | ✅ | `scrapeProfile` |
| like · repost | ✅ | `likeTweet` · `retweet` |
| comment / reply | ✅ | `replyToTweet` |
| follow · unfollow | ✅ | `followByUsername` · `unfollowUser` |
| send a DM | ✅ | `sendDMByUsername` |
| **read the DM inbox** (how she receives X messages) | ✅ | `getInbox` |
| publish a post | ✅ | `postTweet` |
| search · list an account's posts · home feed · notifications | ❌ | not built into the engine yet |
| delete a post / comment | ❌ | not built into the engine |

Every ❌ carries a reason in the manifest, shown in the dashboard ("Why not").

---

## 2. Accounts

Add an X account on the Social screen. Each account has its own switches:

- **Actions** (off by default): nothing is sent until you turn this on for that account.
- **Publishing asks you first** (on by default): posts need your confirmation unless you turn automatic publishing on.

### Connecting an account (no cookies, no browser)

Ariana signs in by herself, **once**, and keeps the login:

1. Put the account's login in the server environment (never in the dashboard):

   | Variable | Needed | What |
   |---|---|---|
   | `X_PASSWORD` | yes | the account's password |
   | `X_USERNAME` | no | defaults to the handle; may be the account's email |
   | `X_EMAIL` | no | answers X's "confirm your email" check |
   | `X_TOTP_SECRET` | if 2FA is on | the base32 secret of the account's authenticator app (shown when you set up 2FA) |
   | `X_CREDENTIALS` | several accounts | JSON: `{"handle":{"password":"…","email":"…","totp":"…"}}` |
   | `X_SESSION_KEY` | no | encrypts the saved login; if unset it is derived from `SUPABASE_SERVICE_ROLE_KEY` |

2. Redeploy, add the account, tap **Connect**. The session cookies are encrypted (AES-256-GCM, bound to the
   account) and stored in your Supabase `ariana_social_config` table (no migration needed). A redeploy or restart
   does not sign her out.
3. **If X asks for a code** (new-device email code, or 2FA with no `X_TOTP_SECRET`), a box appears on the account
   card: type the code and press *Submit code*. The sign-in waits up to 15 minutes in memory.
4. **If X expires the session**, she signs in again on her own, at most once per `X_RELOGIN_MIN_MINUTES` (default 10),
   so a bad password can never turn into a login storm.

**Disconnect** deletes the saved login. **Remove** deletes the account from the list too.

**If sign-in keeps failing:** X may be flagging a login from a data-centre address. Open the account once in the X app
or a browser, approve any "was this you?" prompt, then tap Connect again. If X wants a captcha, Ariana says so
(`unexpected_step`) instead of guessing.

## 3. How Ariana uses it

Her existing reply loop (`generateBrainReply` in `index.js`) already offers her
tools and feeds results back as text. Social tools are added to that same list —
but only for accounts the creator enabled and only for actions the platforms
really support. If she has no enabled accounts, she gets no social tools at all.

Typical flow:

```
someone sends her a post link        → social_view_profile → decides → social_like
she wants to answer something        → social_comment (text written by her, as her)
she wants to reach someone           → social_dm
something is worth putting out       → social_post (X) — needs confirmation unless autopublish
```

Every tool result comes back to her verbatim, including failures, with explicit
instructions: never claim an action she did not take; if the platform cannot do
it, say so; if the backend is not connected, say so. The prompt block that tells
her about her accounts is appended to her existing system prompt — it never
replaces any part of it.

### Autonomy (optional, off by default)

**Social → Autonomy.** When on, a pass every N minutes gathers a few real
candidates — it needs a read action that lists posts, which the built-in X engine does not have yet, so for now a pass finds nothing to look at and says so. Originally: candidates — recent posts from accounts you list, or keyword
searches — and asks *her own prompt* whether anything is worth touching and
what she would say. Her answer runs through the same guarded tools. Doing
nothing is a normal outcome. There is no scoring model, no engagement
optimisation, no second decision-maker.

---

## 4. Limits, confirmations, and what she will not do

Defaults (all overridable, per account, rolling 24h):

| | like | comment/reply | follow | unfollow | dm | post | repost | connect | reads |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| per day | 25 | 8 | 12 | 8 | 6 | 3 | 10 | 6 | generous |

- **Single tool call:** at most 5 targets (`SOCIAL_BATCH_MAX`). Larger is refused
  outright as mass action, not queued.
- **Confirmation required** for: every `unfollow`, every batch of 2+, every
  `post` (unless `autopublish` is enabled for that account), and `read_dms` if
  it ever exists. Confirmations are short-lived (10 min), single-use, scoped to
  one account + one action, issued by a human in the dashboard, and the request
  they replay is the exact single-target request she made.
- **Pacing:** the engine runs one action at a time and waits a randomised gap
  (`SOCIAL_ACTION_GAP_MS`, default 3.5s) between them, on top of the daily
  ceilings above. Two independent caps on purpose.
- **No spam behaviour:** no bulk DM, no follow-churn loops, no retry storms, no
  "run 100 likers". The limits and confirmations are the feature, not friction.
- Failures are never silent: session expiry, platform rejection, an expired login, a code X wants,
  a missing account, a disabled switch — each is a named error, written to the
  activity feed with a reason a person can read.

---

## 5. Activity

**Social → Social Activity**, newest first:

```
X · @ariana_personal
Liked @someone's post                                   ✓ Completed
2 min ago

X · @ariana_personal
Comment failed                                          Failed
Reason: Session expired or not logged in — reconnect this account.
[View details]
```

Entries come from `social/activity.js`, which turns structured engine results
into sentences (`Liked @someone's post`, `Followed @someone`, `Sent a DM to
@someone`) and keeps the raw error behind **View details**. Actions that never
left the building are logged too, with the right status: `Blocked` (limits or
permissions), `Not supported` (platform limitation), `Needs your confirmation`,
`Skipped` (dry run).

Storage: Supabase (`ariana_social_accounts`, `ariana_social_activity`,
`ariana_social_config`) when `SUPABASE_URL` + a service key are set — survives
redeploys; otherwise JSON under `SOCIAL_DATA_DIR` (default `social_data/`,
git-ignored, `0600`, capped at the newest 2000 entries). If Supabase is
configured but a table is missing, Ariana says so once at boot and falls back to
files for that run.

Sessions are *not* here. They belong to the engine and are never written to
Ariana's database or disk.

<details>
<summary>SQL for the three tables (run once in the Supabase SQL editor)</summary>

```sql
create table if not exists ariana_social_accounts (
  account_id      text primary key,
  platform        text not null,
  handle          text not null,
  label           text,
  provider        text,
  actions_enabled boolean default false,
  autopublish     boolean default false,
  status          text,
  status_detail   text,
  last_checked    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists ariana_social_activity (
  id            bigint generated always as identity primary key,
  account_id    text,
  platform      text,
  handle        text,
  action        text,
  target        text,
  target_handle text,
  status        text,
  error         text,
  actor         text,
  summary       text,
  detail        jsonb,
  duration_ms   int,
  created_at    timestamptz default now()
);
create index if not exists ariana_social_activity_created_idx on ariana_social_activity (created_at desc);
create index if not exists ariana_social_activity_account_idx on ariana_social_activity (account_id, created_at desc);

create table if not exists ariana_social_config (
  id         text primary key,
  config     jsonb,
  updated_at timestamptz default now()
);
```

</details>

---
---

## 6. Deployment

There is nothing extra to deploy. The engine runs inside Ariana's existing process.

- **Node:** the vendored client needs no native modules. `undici` (pure JS) provides HTTP/2.
- **Memory:** measured on Node 22, loading the engine raises the process's resident memory by about 18 MB (7.9 MB of
  JS heap). It is plain `fetch` calls: no browser process is started. The WhatsApp stack's Chromium, if you use it,
  is separate and unchanged.
- **Persistence:** with Supabase configured, sessions survive restarts and redeploys. Without it they go to
  `social_data/secrets/` (encrypted, git-ignored) and an ephemeral disk loses them on redeploy.
- **Optional:** `XACTIONS_HOME` (default: a temp dir) caches X's rotating GraphQL query IDs between runs;
  `SOCIAL_DRY_RUN=1` exercises everything without sending.

### Verify a real action end to end

1. Set `X_PASSWORD` (+ `X_EMAIL` / `X_TOTP_SECRET` if needed), redeploy.
2. Social → add the account → **Connect** → status turns **Online** ("Signed in as @handle").
3. Turn **Actions** on, then from Activity or a manual action try a `like` on a tweet URL. It appears in the activity
   feed as *Liked …* (or fails with a plain-language reason).
4. Redeploy once and tap **Re-check**: it should stay Online without signing in again.

---

## 7. Files

| Path | What it is |
|---|---|
| `social/capabilities.json` / `.js` | The honest capability contract and its loader |
| `social/accounts.js` | Account register, permission switches, status, resolution |
| `social/guards.js` | Limits, confirmations, capability/permission gates |
| `social/tools.js` | The tool schemas Ariana's brain sees + the executor |
| `social/activity.js` | Plain-language activity log |
| `social/engine_client.js` | The one seam between this layer and the engine |
| `social/x_engine.js` | The built-in X engine: actions, sessions, auto re-login, pacing |
| `social/x_login.js` | Password + 2FA sign-in over plain HTTP (ported from twikit's flow) |
| `social/session_vault.js` | AES-256-GCM session storage |
| `social/autonomy.js` | Opt-in pass that lets her decide what to engage with |
| `social/api.js` | Dashboard routes (`/api/social/*`, behind dashboard auth) |
| `social/store.js` | Supabase-or-file persistence for accounts, config, activity and encrypted sessions |
| `vendor/xactions/` | Trimmed copy of XActions' HTTP client (Apache-2.0) — see its `NOTICE.md` |
| `tests/` | `social-manifest`, `social-guards`, `social-tools`, `social-brain`, `social-screen`, `x-login`, `x-engine`, `x-channel`, `dashboard` |

## 8. Security notes

- **No credentials in the frontend, ever; no route accepts a password or a cookie.** The password lives only in the
  server environment. The dashboard can only submit a one-time verification code.
- Sessions are stored only as AES-256-GCM ciphertext, bound to the account; the key is `X_SESSION_KEY` or derived
  from the Supabase service key, so a leaked database dump alone is useless. They are never returned by any API.
- `social_data/` and `.env` files are git-ignored. Nothing secret is committed.
- The dashboard's social routes sit behind the same `requireDashboardAuth` as `/api/talk`; set `DASHBOARD_SECRET`
  or they are open to anyone who can reach the app.
- This works by using X's own web endpoints with a logged-in session, the way a browser does. That is outside X's
  official API and its terms: the account can be rate-limited, locked or suspended, and X can change its endpoints
  without notice (the vendored client re-discovers GraphQL query IDs automatically, but a larger change can break a
  call until the client is updated). Limits here are deliberately conservative; they are not a guarantee.

---

## X as a chat channel (like WhatsApp, through this engine)

X shows up next to WhatsApp, Telegram and Snapchat: a home tile, a Settings card, and X chats in the chat list
(conversation ids look like `x_<handle>`). It uses the built-in X engine in both directions: no extra service, no
paid X API.

1. Social: add your X account, **Connect**, and turn **Actions** on.
2. Settings → X → **Check messages now**.

How it behaves:
- **Out:** her reply is sent as a normal social `dm`, so every guard applies (creator switch, daily ceiling
  `X_CHANNEL_MAX_REPLIES_PER_DAY`, dry run, activity log). Text only.
- **In:** incoming DMs are pulled with one inbox request **when you press the button**. Nothing runs on a timer
  unless you set `X_INBOX_POLL_MINUTES` (each check is one cheap HTTP request).
- **First check answers nothing**: it only learns what is already in the inbox, so she never replies to old history.
- She only answers a conversation when the inbox says the **last message was not hers**; if it cannot tell, she stays
  quiet. Each message is marked answered before she replies, so a failure can never produce a double reply.
- At most `X_INBOX_MAX_PER_CHECK` (default 5) new conversations per check. She does not message first on X unless
  `X_PROACTIVE=on`.
