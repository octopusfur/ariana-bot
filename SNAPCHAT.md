# Snapchat channel

Ariana talks on Snapchat through the unofficial Snapchat Web API
([etrnkz/snapchat-unofficial-api](https://github.com/etrnkz/snapchat-unofficial-api), MIT, vendored and patched in
`snapchat-service/`). It is a small Python sidecar on its own Render service.

**Read this first.** This is not an official API. It can break any time Snapchat changes its web app, and automating
an account is against Snapchat's terms, so the account can be locked or banned. Use a dedicated account, not a personal one.

## Setup

Two separate pieces. Posting Stories and Spotlight does not need the chat sidecar at all.

**A. Stories and Spotlight (supported API, BulkPublish)**

1. Create an account at app.bulkpublish.com, connect the Snapchat Public Profile under Channels, and create an API key under
   Settings > Developer (free plan: 100 API requests a day).
2. Render env on the main app: `BULKPUBLISH_API_KEY`. Optional: `BULKPUBLISH_SNAPCHAT_CHANNEL_ID`, and `SNAPCHAT_STORY_POSTS=on`
   to let her post 1-2 stories a day from her media library.
3. `POST /api/snapchat/story` `{ "url" }` or `{ "mediaId" }`, `POST /api/snapchat/spotlight` `{ "url", "caption" }` (vertical mp4/mov, 6-60 s),
   `POST /api/snapchat/saved-story` `{ "url", "title" }`. `GET /api/snapchat/publish-status` shows whether the channel is connected.

**B. Chat replies (unofficial Web API sidecar, runs on Render)**

1. Render > New > Web Service > Docker, repo `ariana-bot`, root directory `snapchat-service`. Env: `SNAP_API_SECRET=<random>`,
   `MAIN_APP_URL=https://<main app>.onrender.com`. Keep it at 1 instance, it polls.
2. Main app env: `SNAP_SERVICE_URL=https://<sidecar>.onrender.com` and the same `SNAP_API_SECRET`.
3. Sign in (dashboard key required), either way:
   - `POST /api/snapchat/login` `{ "username", "password", "userUuid" }`
   - `POST /api/snapchat/session` `{ "cookies": <browser cookie export or name/value object>, "userUuid" }`
   The session is saved in Supabase `sessions` (type `snapchat`) and re-sent to the sidecar after every redeploy. Passwords are never stored.
4. `userUuid` is the Snapchat user id of the account Ariana uses. Until it is set the sidecar refuses to send or read, because
   the upstream library only knows how to tell her messages from others by that id.
5. Choose which chats she answers: `GET /api/snapchat/conversations/candidates` suggests ids found in the account's sync data,
   then `POST /api/snapchat/conversations` `{ "add": ["<conversation-uuid>"] }`. Only listed chats are ever read or answered.

## What works

| Feature | Status |
|---|---|
| Reply to text chats (brain, memory, persona, same as other channels) | built, needs a live account to confirm |
| Send text (long and non-ASCII messages fixed in the vendored client) | built |
| Send her own pictures and videos (`ariana_media` flow) | built, via image upload |
| Friends list, incoming friend requests, add friend, user lookup | passthrough, returns raw data |
| Stories and Spotlight feeds, media download (Snapchat CDN only) | passthrough |
| Post a Story, Saved Story, Spotlight | built, through BulkPublish (section A), needs a free BulkPublish account with Snapchat connected |
| Like, comment, follow | **not possible**: the chat library has no working endpoint, routes return 501 |
| Voice notes | not supported, she sends the text instead |

## Safety rails

- Reads and answers only allowlisted chats; history before startup is never answered; her own messages are never echoed back to her.
- Max `SNAP_MAX_SENDS_PER_HOUR` (default 30) per chat. `POST /api/snapchat/pause` stops all polling at once.
- She does not text first on Snapchat unless `SNAPCHAT_PROACTIVE=on`.
- Inbound reading scrapes Snapchat's sync payload heuristically, so expect misses until it has been tuned against a real account.

## Tests

`node --test tests/snapchat.test.js` and `cd snapchat-service && python3 -m unittest discover -s tests`.
