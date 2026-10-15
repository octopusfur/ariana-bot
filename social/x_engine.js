// social/x_engine.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's hands on X — through the official X API, via the X service
// (x-service/), which wraps X's own xmcp server.
//
// This file has the same job as browseruse_engine.js and engine_client.js's
// HTTP path: take (account, action, payload) from social/tools.js and either do
// it or say honestly why not. It never throws; every function resolves to
// { ok: true, ... } or { ok: false, code, error }.
//
// THE RULE THIS FILE EXISTS TO KEEP: nothing here runs on a timer.
// The X service sleeps when idle (that is what keeps it cheap) and a request is
// what wakes it. So:
//   · health(), sessions(), sessionStatus() answer from local config and NEVER
//     touch the network — opening the dashboard must not wake the service;
//   · the service is contacted only when an action actually runs, or when the
//     creator presses Connect;
//   · input is validated locally BEFORE waking it, so a bad request costs
//     nothing;
//   · only the connection/handshake is retried while the service wakes. A tool
//     call that writes (post, reply, follow, DM…) is sent once and never
//     retried — a timeout there must not become a double post.
//
// One X service = one X account (its four OAuth values live in its environment).
// Before any action, the account the service is really authenticated as is
// compared with the account Ariana was told to use; a mismatch stops the action.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const WAKE_BUDGET_MS = () => num(process.env.X_SERVICE_WAKE_MS, 150000); // cold start can take ~1–2 min
const CALL_TIMEOUT_MS = () => num(process.env.X_SERVICE_CALL_MS, 60000);
const RETRY_PAUSE_MS = () => num(process.env.X_SERVICE_RETRY_PAUSE_MS, 4000);
const ME_TTL_MS = 15 * 60 * 1000;

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── CONFIG ──────────────────────────────────────────────────────────────────

function baseUrl() {
  let raw = (process.env.X_SERVICE_URL || '').trim().replace(/\/+$/, '');
  raw = raw.replace(/\/mcp$/i, ''); // tolerate the endpoint pasted in full
  return /^https?:\/\/[^\s/]+/i.test(raw) ? raw : null;
}

function apiKey() {
  return (process.env.X_SERVICE_API_KEY || '').trim() || null;
}

// Both are required: an unauthenticated X service must never be talked to.
function configured() {
  return !!baseUrl() && !!apiKey();
}

function handles(account) {
  return !!(account && account.platform === 'twitter' && configured());
}

const HINT = 'Set X_SERVICE_URL (the X service address) and X_SERVICE_API_KEY (the same key the service uses).';

function notConfigured() {
  return { ok: false, code: 'not_configured', error: 'The X service is not connected — ' + HINT };
}

// ── PARSING / VALIDATION (all local) ────────────────────────────────────────

function normalizeUsername(value) {
  const u = String(value || '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(u) ? u : null;
}

function parseTweetId(value) {
  const s = String(value || '').trim();
  const m = s.match(/(?:twitter\.com|x\.com)\/[^/\s?#]+\/status(?:es)?\/(\d{5,25})/i);
  if (m) return m[1];
  return /^\d{5,25}$/.test(s) ? s : null;
}

function badTarget(error) {
  return { ok: false, code: 'bad_target', error };
}

// ── ERROR / RESULT MAPPING ──────────────────────────────────────────────────

function textOf(res) {
  return (res && Array.isArray(res.content) ? res.content : [])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

function errorFromText(text) {
  const t = String(text || '');
  if (/unknown tool|tool .* not found|no such tool/i.test(t)) {
    return { code: 'tool_missing', error: 'The X service does not expose that action — check X_API_TOOL_ALLOWLIST on the service.' };
  }
  if (/rate limited|\b429\b/i.test(t)) {
    return { code: 'rate_limited', error: 'X is rate limiting this account right now — try again later.' };
  }
  if (/\b401\b/.test(t)) {
    return { code: 'x_unauthorized', error: 'X rejected the service\'s credentials (401). Regenerate the access token and secret and update them on the X service.' };
  }
  if (/\b402\b/.test(t)) {
    return { code: 'x_payment_required', error: 'X refused the request for billing reasons (402) — check the API plan or credits on the X developer account.' };
  }
  if (/\b403\b/.test(t)) {
    const detail = (t.match(/'detail':\s*'([^']+)'/) || t.match(/"detail":\s*"([^"]+)"/) || [])[1];
    return { code: 'x_forbidden', error: `X refused this (403)${detail ? ': ' + detail.replace(/[.\s]+$/, '') : ''}. If this keeps happening, check the app has Read and write permission and that the account is allowed to do it.` };
  }
  if (/\b404\b/.test(t)) {
    return { code: 'not_found', error: 'X could not find that.' };
  }
  return { code: 'x_error', error: t.slice(0, 300) || 'X returned an error.' };
}

// Turns an MCP tool result into { ok, data } | { ok:false, code, error }.
// X answers "not found" with a 200 that has `errors` and no `data` — that is a
// failure, not a success with nothing in it.
function parseToolResult(res) {
  if (!res) return { ok: false, code: 'x_error', error: 'The X service returned nothing.' };
  if (res.isError) return { ok: false, ...errorFromText(textOf(res)) };

  let body = res.structuredContent;
  if (!body || typeof body !== 'object') {
    const text = textOf(res);
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'x_error', error: 'The X service answered in a shape Ariana does not understand.' };
  }
  if (body.errors && !body.data) {
    const first = body.errors[0] || {};
    if (/resource-not-found/.test(String(first.type || '')) || /not found/i.test(String(first.title || ''))) {
      return { ok: false, code: 'not_found', error: first.detail || 'X could not find that.' };
    }
    return { ok: false, code: 'x_error', error: first.detail || first.title || 'X returned an error.' };
  }
  return { ok: true, data: body.data !== undefined ? body.data : null, includes: body.includes || null, meta: body.meta || null };
}

// ── TRANSPORT ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function transientStatus(e) {
  const code = e && (e.code !== undefined ? e.code : e.status);
  return [502, 503, 504, 521, 522, 523, 524].includes(code);
}

// Errors that mean "the service is still waking up / the network blinked" —
// the only kind that is safe to retry, and only before anything was written.
function isTransient(e) {
  if (!e) return false;
  if (transientStatus(e)) return true;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (e.code === -32001) return true; // MCP request timeout
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|HTTP 50[234]|timed out/i.test(String(e.message || ''));
}

function describeConnectError(e, waitedMs) {
  const msg = String((e && e.message) || e);
  if (e && (e.code === 401 || e.code === 403 || /HTTP 40[13]/.test(msg))) {
    return { ok: false, code: 'unauthorized', error: 'The X service rejected the API key — check X_SERVICE_API_KEY matches on both sides.' };
  }
  if (e && e.code === 404 || /HTTP 404/.test(msg)) {
    return { ok: false, code: 'not_found', error: 'The X service has no /mcp endpoint at that address — check X_SERVICE_URL.' };
  }
  if (isTransient(e)) {
    return {
      ok: false,
      code: 'unreachable',
      error: `The X service did not come up within ${Math.round(waitedMs / 1000)}s (${msg}). It may still be starting — try again in a minute.`,
    };
  }
  return { ok: false, code: 'unreachable', error: `Cannot reach the X service (${msg}).` };
}

let sdk = null;
function loadSdk() {
  if (!sdk) {
    sdk = {
      Client: require('@modelcontextprotocol/sdk/client/index.js').Client,
      Transport: require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport,
    };
  }
  return sdk;
}

// Opens a fresh MCP connection. The wake-up is absorbed HERE: this is the only
// place a retry happens, and nothing has been written yet when it does.
async function connect() {
  const { Client, Transport } = loadSdk();
  const url = new URL(baseUrl() + '/mcp');
  const budget = WAKE_BUDGET_MS();
  const started = Date.now();
  let lastError = null;

  for (let attempt = 1; ; attempt++) {
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) break;
    const client = new Client({ name: 'ariana-bot', version: '1.0.0' });
    const transport = new Transport(url, { requestInit: { headers: { 'X-Api-Key': apiKey() } } });
    try {
      await client.connect(transport, { timeout: remaining });
      return {
        ok: true,
        client,
        close: async () => { try { await client.close(); } catch (_) { /* already closed */ } },
      };
    } catch (e) {
      lastError = e;
      try { await client.close(); } catch (_) { /* nothing to close */ }
      if (!isTransient(e)) break;
      const left = budget - (Date.now() - started);
      if (left <= RETRY_PAUSE_MS()) break;
      await sleep(RETRY_PAUSE_MS());
    }
  }
  return describeConnectError(lastError, Date.now() - started);
}

// One tool call. NEVER retried — see the header.
async function callTool(client, name, args) {
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS() });
    return parseToolResult(res);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e && (e.code === -32001 || /timed out/i.test(msg))) {
      return {
        ok: false,
        code: 'timeout',
        error: `The X service did not answer within ${Math.round(CALL_TIMEOUT_MS() / 1000)}s — the action may still have gone through, so check X before trying again.`,
      };
    }
    if (/Unknown tool|not found/i.test(msg) && /tool/i.test(msg)) return { ok: false, ...errorFromText('unknown tool') };
    return { ok: false, code: 'x_error', error: `The X service call failed (${msg}).` };
  }
}

// ── IDENTITY ────────────────────────────────────────────────────────────────

let meCache = null; // { id, username, at }

async function getMe(client, { fresh = false } = {}) {
  if (!fresh && meCache && Date.now() - meCache.at < ME_TTL_MS) return { ok: true, me: meCache };
  const r = await callTool(client, 'getUsersMe', {});
  if (!r.ok) return r;
  const d = r.data || {};
  if (!d.id || !d.username) return { ok: false, code: 'x_error', error: 'X did not say which account the service is signed in as.' };
  meCache = { id: String(d.id), username: String(d.username), at: Date.now() };
  return { ok: true, me: meCache };
}

function sameHandle(a, b) {
  return String(a || '').replace(/^@/, '').toLowerCase() === String(b || '').replace(/^@/, '').toLowerCase();
}

function mismatch(me, account) {
  return {
    ok: false,
    code: 'account_mismatch',
    error: `The X service is signed in as @${me.username}, not @${account.handle}. Nothing was sent. Either use @${me.username} here, or put @${account.handle}'s tokens on the X service.`,
  };
}

// ── ACTIONS ─────────────────────────────────────────────────────────────────
// Each handler has a local `prepare` (validates, no network) and a `run`
// (the X calls). Canonical action names match social/capabilities.json.

const PROFILE_FIELDS = ['name', 'username', 'description', 'created_at', 'public_metrics', 'protected', 'verified'];

async function lookupUser(conn, username) {
  const r = await callTool(conn.client, 'getUsersByUsername', { username, 'user.fields': PROFILE_FIELDS });
  if (!r.ok) {
    if (r.code === 'not_found') return { ok: false, code: 'not_found', error: `@${username} was not found on X.` };
    return r;
  }
  if (!r.data || !r.data.id) return { ok: false, code: 'not_found', error: `@${username} was not found on X.` };
  return r;
}

function profileOf(u) {
  const m = u.public_metrics || {};
  return {
    username: u.username,
    name: u.name,
    bio: u.description || '',
    followers: m.followers_count,
    following: m.following_count,
    tweets: m.tweet_count,
    joined: u.created_at || null,
    protected: !!u.protected,
    url: `https://x.com/${u.username}`,
  };
}

// ── LIST-SHAPED READS ───────────────────────────────────────────────────────
// 20 satisfies every endpoint's minimum page size (search 10, posts/mentions 5).
const PAGE = 20;
const TWEET_FIELDS = ['created_at', 'author_id', 'text', 'conversation_id'];
const TWEET_EXPANSIONS = ['author_id'];
const AUTHOR_FIELDS = ['username', 'name'];

function usersById(includes) {
  const map = new Map();
  for (const u of (includes && includes.users) || []) map.set(String(u.id), u);
  return map;
}

function postsFrom(r) {
  const users = usersById(r.includes);
  const list = Array.isArray(r.data) ? r.data : [];
  return list.map((t) => {
    const a = users.get(String(t.author_id));
    const author = a ? a.username : null;
    return {
      id: String(t.id),
      url: author ? `https://x.com/${author}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
      author,
      text: t.text,
      at: t.created_at || null,
    };
  });
}

const TWEET_READ = { 'tweet.fields': TWEET_FIELDS, expansions: TWEET_EXPANSIONS, 'user.fields': AUTHOR_FIELDS, max_results: PAGE };

// The handle inside a post URL, if it has one — used so Ariana can only delete her own posts.
function urlAuthor(value) {
  const m = String(value || '').match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status/i);
  return m && m[1].toLowerCase() !== 'i' ? m[1] : null;
}

const HANDLERS = {
  search: {
    prepare(p) {
      const query = String(p.query || '').trim();
      if (!query) return badTarget('There is nothing to search for — the query is empty.');
      if (query.length > 512) return badTarget('That search is too long for X (512 characters at most).');
      return { ok: true, args: { query } };
    },
    async run(conn, me, { query }) {
      const r = await callTool(conn.client, 'searchPostsRecent', { query, ...TWEET_READ });
      return r.ok ? { ok: true, data: { posts: postsFrom(r), query } } : r;
    },
  },

  view_posts: {
    prepare(p) { return HANDLERS.view_profile.prepare(p); },
    async run(conn, me, { username }) {
      const target = await lookupUser(conn, username);
      if (!target.ok) return target;
      const r = await callTool(conn.client, 'getUsersPosts', { id: String(target.data.id), ...TWEET_READ });
      if (!r.ok) return r;
      // A profile's posts come back without the author expansion filled for every row; the owner is known.
      const posts = postsFrom(r).map((x) => ({ ...x, author: x.author || target.data.username, url: `https://x.com/${target.data.username}/status/${x.id}` }));
      return { ok: true, data: { posts, username: target.data.username } };
    },
  },

  view_feed: {
    prepare() { return { ok: true, args: {} }; },
    async run(conn, me) {
      const r = await callTool(conn.client, 'getUsersTimeline', { id: me.id, ...TWEET_READ });
      return r.ok ? { ok: true, data: { posts: postsFrom(r) } } : r;
    },
  },

  // X has no "notifications tab" in its API; the closest real thing is who mentioned her.
  notifications: {
    prepare() { return { ok: true, args: {} }; },
    async run(conn, me) {
      const r = await callTool(conn.client, 'getUsersMentions', { id: me.id, ...TWEET_READ });
      return r.ok ? { ok: true, data: { kind: 'mentions', items: postsFrom(r) } } : r;
    },
  },

  read_dms: {
    prepare(p) {
      if (p.username === undefined || p.username === null || String(p.username).trim() === '') return { ok: true, args: { username: null } };
      const username = normalizeUsername(p.username);
      return username ? { ok: true, args: { username } } : badTarget('That is not a valid X handle.');
    },
    async run(conn, me, { username }) {
      const fields = { 'dm_event.fields': ['created_at', 'sender_id', 'text', 'dm_conversation_id', 'event_type'], expansions: ['sender_id'], 'user.fields': AUTHOR_FIELDS, max_results: PAGE };
      let r;
      if (username) {
        const target = await lookupUser(conn, username);
        if (!target.ok) return target;
        r = await callTool(conn.client, 'getDirectMessagesEventsByParticipantId', { participant_id: String(target.data.id), ...fields });
      } else {
        r = await callTool(conn.client, 'getDirectMessagesEvents', fields);
      }
      if (!r.ok) return r;
      const users = usersById(r.includes);
      const items = (Array.isArray(r.data) ? r.data : [])
        .filter((e) => !e.event_type || e.event_type === 'MessageCreate')
        .map((e) => {
          const u = users.get(String(e.sender_id));
          return { id: String(e.id), from: u ? u.username : String(e.sender_id), from_me: String(e.sender_id) === me.id, text: e.text || '', at: e.created_at || null };
        });
      return { ok: true, data: { items, with: username } };
    },
  },

  delete_post: {
    prepare(p) {
      const tweetId = parseTweetId(p.url);
      return tweetId ? { ok: true, args: { tweetId, author: urlAuthor(p.url) } } : badTarget('That is not a link to a post on X.');
    },
    async run(conn, me, { tweetId, author }) {
      // Only her own. X would refuse anyway; refusing here means no call is made at all.
      if (author && author.toLowerCase() !== me.username.toLowerCase()) {
        return { ok: false, code: 'not_yours', error: `That post is by @${author}, not @${me.username} — she can only delete her own posts. Nothing was sent.` };
      }
      const r = await callTool(conn.client, 'deletePosts', { id: tweetId });
      if (!r.ok) return r;
      return r.data && r.data.deleted === true
        ? { ok: true, data: { deleted: true, tweet_id: tweetId } }
        : { ok: false, code: 'x_error', error: 'X did not confirm the post was deleted.' };
    },
  },

  delete_comment: {
    prepare(p) { return HANDLERS.delete_post.prepare(p); },
    run(conn, me, args) { return HANDLERS.delete_post.run(conn, me, args); },
  },

  view_profile: {
    prepare(p) {
      const username = normalizeUsername(p.username);
      return username ? { ok: true, args: { username } } : badTarget('That is not a valid X handle.');
    },
    async run(conn, me, { username }) {
      const r = await lookupUser(conn, username);
      return r.ok ? { ok: true, data: profileOf(r.data) } : r;
    },
  },

  engagement: {
    prepare(p) { return HANDLERS.view_profile.prepare(p); },
    async run(conn, me, { username }) {
      const r = await lookupUser(conn, username);
      if (!r.ok) return r;
      const m = r.data.public_metrics || {};
      return { ok: true, data: { username: r.data.username, followers: m.followers_count, following: m.following_count, tweets: m.tweet_count } };
    },
  },

  post: {
    prepare(p) {
      const text = String(p.text || '').trim();
      return text ? { ok: true, args: { text } } : badTarget('There is nothing to post — the text is empty.');
    },
    async run(conn, me, { text }) {
      const r = await callTool(conn.client, 'createPosts', { text });
      if (!r.ok) return r;
      if (!r.data || !r.data.id) return { ok: false, code: 'x_error', error: 'X did not confirm the post was created.' };
      return { ok: true, data: { id: String(r.data.id), url: `https://x.com/${me.username}/status/${r.data.id}` } };
    },
  },

  reply: {
    prepare(p) {
      const tweetId = parseTweetId(p.url);
      if (!tweetId) return badTarget('That is not a link to a post on X.');
      const text = String(p.text || '').trim();
      if (!text) return badTarget('There is nothing to reply with — the text is empty.');
      return { ok: true, args: { tweetId, text } };
    },
    async run(conn, me, { tweetId, text }) {
      const r = await callTool(conn.client, 'createPosts', { text, reply: { in_reply_to_tweet_id: tweetId } });
      if (!r.ok) return r;
      if (!r.data || !r.data.id) return { ok: false, code: 'x_error', error: 'X did not confirm the reply was created.' };
      return { ok: true, data: { id: String(r.data.id), url: `https://x.com/${me.username}/status/${r.data.id}`, in_reply_to: tweetId } };
    },
  },

  // On X a comment IS a reply; the tool layer sends it under the name `comment`.
  comment: {
    prepare(p) { return HANDLERS.reply.prepare(p); },
    run(conn, me, args) { return HANDLERS.reply.run(conn, me, args); },
  },

  like: {
    prepare(p) {
      const tweetId = parseTweetId(p.url);
      return tweetId ? { ok: true, args: { tweetId } } : badTarget('That is not a link to a post on X.');
    },
    async run(conn, me, { tweetId }) {
      const r = await callTool(conn.client, 'likePost', { id: me.id, tweet_id: tweetId });
      if (!r.ok) return r;
      return r.data && r.data.liked === true
        ? { ok: true, data: { liked: true, tweet_id: tweetId } }
        : { ok: false, code: 'x_error', error: 'X did not confirm the like.' };
    },
  },

  repost: {
    prepare(p) { return HANDLERS.like.prepare(p); },
    async run(conn, me, { tweetId }) {
      const r = await callTool(conn.client, 'repostPost', { id: me.id, tweet_id: tweetId });
      if (!r.ok) return r;
      return r.data && r.data.retweeted === true
        ? { ok: true, data: { reposted: true, tweet_id: tweetId } }
        : { ok: false, code: 'x_error', error: 'X did not confirm the repost.' };
    },
  },

  follow: {
    prepare(p) { return HANDLERS.view_profile.prepare(p); },
    async run(conn, me, { username }) {
      const target = await lookupUser(conn, username);
      if (!target.ok) return target;
      if (String(target.data.id) === me.id) return badTarget('That is the account itself — it cannot follow itself.');
      const r = await callTool(conn.client, 'followUser', { id: me.id, target_user_id: String(target.data.id) });
      if (!r.ok) return r;
      const d = r.data || {};
      if (d.following === true) return { ok: true, data: { following: true, username } };
      if (d.pending_follow === true) return { ok: true, data: { following: false, pending: true, username } };
      return { ok: false, code: 'x_error', error: 'X did not confirm the follow.' };
    },
  },

  unfollow: {
    prepare(p) { return HANDLERS.view_profile.prepare(p); },
    async run(conn, me, { username }) {
      const target = await lookupUser(conn, username);
      if (!target.ok) return target;
      const r = await callTool(conn.client, 'unfollowUser', { source_user_id: me.id, target_user_id: String(target.data.id) });
      if (!r.ok) return r;
      return r.data && r.data.following === false
        ? { ok: true, data: { following: false, username } }
        : { ok: false, code: 'x_error', error: 'X did not confirm the unfollow.' };
    },
  },

  dm: {
    prepare(p) {
      const username = normalizeUsername(p.username);
      if (!username) return badTarget('That is not a valid X handle.');
      const message = String(p.message || '').trim();
      if (!message) return badTarget('There is nothing to send — the message is empty.');
      return { ok: true, args: { username, message } };
    },
    async run(conn, me, { username, message }) {
      const target = await lookupUser(conn, username);
      if (!target.ok) return target;
      const r = await callTool(conn.client, 'createDirectMessagesByParticipantId', { participant_id: String(target.data.id), text: message });
      if (!r.ok) return r;
      return r.data && (r.data.dm_event_id || r.data.dm_conversation_id)
        ? { ok: true, data: { sent: true, username } }
        : { ok: false, code: 'x_error', error: 'X did not confirm the message was sent.' };
    },
  },
};

// payload is the action payload social/tools.js builds (payloadFor).
async function act(account, action, payload) {
  if (!configured()) return notConfigured();
  const handler = HANDLERS[action];
  if (!handler) {
    return { ok: false, code: 'unsupported', error: `"${action}" is not something Ariana can do on X through the X service.` };
  }

  // Validate before waking anything: a bad request must cost nothing.
  const prep = handler.prepare(payload || {});
  if (!prep.ok) return prep;

  const conn = await connect();
  if (!conn.ok) return conn;
  try {
    const who = await getMe(conn.client);
    if (!who.ok) return who;
    if (!sameHandle(who.me.username, account.handle)) return mismatch(who.me, account);

    const out = await handler.run(conn, who.me, prep.args);
    if (!out.ok) return out;
    return { ok: true, result: { success: true, platform: 'twitter', action, data: out.data } };
  } finally {
    await conn.close();
  }
}

// ── STATUS (local; these must never wake the service) ───────────────────────

async function health() {
  if (!configured()) return notConfigured();
  return {
    ok: true,
    health: {
      provider: 'x-api',
      mode: 'on-demand',
      reachable: 'not checked',
      note: 'The X service sleeps when idle and is only contacted when an action runs or you press Connect, so this is not a live check.',
    },
  };
}

async function sessions() {
  return { ok: true, sessions: [] };
}

async function sessionStatus() {
  if (!configured()) return notConfigured();
  return { ok: true, session: { exists: true, has_session: true, detail: 'Credentials are held by the X service. Press Connect to check them live.' } };
}

// What each tool must accept, as the service generates it. Checked on Connect
// so a mismatch is reported in words instead of failing mid-conversation.
const EXPECTED_TOOLS = {
  getUsersMe: [],
  getUsersByUsername: ['username'],
  createPosts: ['text', 'reply'],
  likePost: ['id', 'tweet_id'],
  repostPost: ['id', 'tweet_id'],
  followUser: ['id', 'target_user_id'],
  unfollowUser: ['source_user_id', 'target_user_id'],
  createDirectMessagesByParticipantId: ['participant_id', 'text'],
};

// Behind the extra read/delete features. If the service's allowlist leaves one out,
// that feature reports "not exposed" when used — Connect still succeeds.
const OPTIONAL_TOOLS = {
  searchPostsRecent: ['query'],
  getUsersPosts: ['id'],
  getUsersTimeline: ['id'],
  getUsersMentions: ['id'],
  deletePosts: ['id'],
  getDirectMessagesEvents: [],
  getDirectMessagesEventsByParticipantId: ['participant_id'],
};

function missingOptional(list) {
  const have = new Set((list || []).map((t) => t.name));
  return Object.keys(OPTIONAL_TOOLS).filter((n) => !have.has(n));
}

function auditTools(list) {
  const byName = new Map((list || []).map((t) => [t.name, t]));
  const problems = [];
  for (const [name, props] of Object.entries(EXPECTED_TOOLS)) {
    const tool = byName.get(name);
    if (!tool) { problems.push(`${name} is not exposed`); continue; }
    const have = Object.keys((tool.inputSchema && tool.inputSchema.properties) || {});
    const lacking = props.filter((p) => !have.includes(p));
    if (lacking.length) problems.push(`${name} does not take ${lacking.join(', ')} (it takes: ${have.join(', ') || 'nothing'})`);
  }
  return problems;
}

// The one deliberate round trip: user-initiated (Connect), wakes the service,
// proves the key, the X credentials, the tool list and the account identity.
async function verify(account) {
  if (!configured()) return notConfigured();
  const conn = await connect();
  if (!conn.ok) return conn;
  try {
    let listed;
    try {
      listed = await conn.client.listTools();
    } catch (e) {
      return { ok: false, code: 'unreachable', error: `The X service connected but would not list its tools (${e.message}).` };
    }
    const problems = auditTools(listed && listed.tools);
    if (problems.length) {
      return { ok: true, session: { connected: false, detail: 'The X service is up but its tools do not match what Ariana needs: ' + problems.join('; ') + '.' } };
    }
    const who = await getMe(conn.client, { fresh: true });
    if (!who.ok) return { ok: true, session: { connected: false, detail: who.error } };
    if (!sameHandle(who.me.username, account.handle)) {
      return { ok: true, session: { connected: false, detail: mismatch(who.me, account).error } };
    }
    const off = missingOptional(listed && listed.tools);
    const note = off.length ? ` Not exposed by the service (those features will say so): ${off.join(', ')}.` : '';
    return { ok: true, session: { connected: true, detail: `Verified live: the X service is signed in as @${who.me.username}.${note}` } };
  } finally {
    await conn.close();
  }
}

async function importSession() {
  return { ok: false, code: 'unsupported', error: 'X uses API keys held by the X service, not browser sessions — there is nothing to import. See x-service/README.md.' };
}

async function disconnect() {
  return { ok: false, code: 'unsupported', error: 'The X credentials live on the X service. To disconnect, remove them from that service\'s environment.' };
}

function supportedActions() { return Object.keys(HANDLERS); }

function _resetForTests() { meCache = null; }

module.exports = {
  configured, handles, baseUrl, apiKey, HINT,
  health, sessions, sessionStatus, verify, importSession, disconnect, act,
  // exposed for tests
  supportedActions, parseToolResult, parseTweetId, normalizeUsername, auditTools, missingOptional, isTransient, _resetForTests,
};
