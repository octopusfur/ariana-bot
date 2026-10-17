// social/x_engine.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's X (Twitter) engine. In-process, plain HTTP, no browser, no paid X API:
//
//   · Talks to x.com's own web endpoints through a vendored, trimmed copy of XActions' HTTP client
//     (vendor/xactions, Apache-2.0). That client also rediscovers X's rotating GraphQL query IDs.
//   · Signs in with the account's username + password (x_login.js), once. The resulting cookies are
//     encrypted into Supabase (session_vault.js), so a redeploy or restart does not sign her out.
//   · If X ever expires the session, it signs in again by itself (rate-limited) using the same
//     server-side credentials. You never copy a cookie and never open a browser.
//
// Credentials live only in the server environment (never the dashboard):
//     X_PASSWORD            required       (X_USERNAME defaults to the account's handle; may be an email)
//     X_EMAIL               optional       answers X's "confirm your email" check
//     X_TOTP_SECRET         optional       base32 secret of the account's authenticator app (2FA)
//   or, for several accounts:  X_CREDENTIALS='{"handle":{"password":"…","email":"…","totp":"…"}}'
//
// Same contract the rest of Ariana already uses: every function resolves { ok: true, … } or
// { ok: false, code, error } and never throws.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const accounts = require('./accounts');
const vault = require('./session_vault');
const store = require('./store');
const caps = require('./capabilities');
const { XLogin, XLoginError } = require('./x_login');

const PLATFORM = 'twitter';
const PENDING_TTL_MS = 15 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gapMs = () => Number(process.env.SOCIAL_ACTION_GAP_MS ?? 3500);
const reloginGapMs = () => Number(process.env.X_RELOGIN_MIN_MINUTES ?? 10) * 60 * 1000;

// ── vendored client, loaded once ────────────────────────────────────────────
let _lib = null;
let _libOverride = null; // tests
async function lib() {
  if (_libOverride) return _libOverride;
  if (_lib) return _lib;
  if (!process.env.XACTIONS_HOME) process.env.XACTIONS_HOME = path.join(os.tmpdir(), 'ariana-xactions');
  const root = path.join(__dirname, '..', 'vendor', 'xactions', 'src', 'scrapers', 'twitter', 'http');
  const imp = (f) => import(pathToFileURL(path.join(root, f)).href);
  const [client, actions, engagement, dm, profile, endpoints, errors, txid] = await Promise.all([
    imp('client.js'), imp('actions.js'), imp('engagement.js'), imp('dm.js'), imp('profile.js'),
    imp('endpoints.js'), imp('errors.js'), imp('transactionId.js'),
  ]);
  _lib = {
    TwitterHttpClient: client.TwitterHttpClient,
    postTweet: actions.postTweet, replyToTweet: actions.replyToTweet,
    likeTweet: engagement.likeTweet, retweet: engagement.retweet,
    followByUsername: engagement.followByUsername, unfollowUser: engagement.unfollowUser,
    sendDMByUsername: dm.sendDMByUsername, getInbox: dm.getInbox,
    scrapeProfile: profile.scrapeProfile,
    REST: endpoints.REST, USER_AGENTS: endpoints.USER_AGENTS,
    errors,
    getTransactionId: txid.getTransactionId,
  };
  return _lib;
}

// ── credentials (server env only) ───────────────────────────────────────────
const cleanHandle = (h) => String(h || '').trim().replace(/^@/, '');

function credsFor(account) {
  const handle = cleanHandle(account.handle);
  let map = {};
  try { map = JSON.parse(process.env.X_CREDENTIALS || '{}') || {}; } catch (_) { map = {}; }
  const per = map[handle] || map[handle.toLowerCase()] || null;
  const envUser = cleanHandle(process.env.X_USERNAME);
  const single = !envUser || envUser.toLowerCase() === handle.toLowerCase() || envUser.includes('@');
  const c = per || (process.env.X_PASSWORD && single
    ? { password: process.env.X_PASSWORD, email: process.env.X_EMAIL, totp: process.env.X_TOTP_SECRET, username: process.env.X_USERNAME }
    : null);
  if (!c || !c.password) return null;
  return { username: cleanHandle(c.username) || handle, password: c.password, email: c.email || '', totpSecret: c.totp || c.totpSecret || '' };
}

// Details typed into Settings win; the server environment (X_PASSWORD …) still works as a fallback.
async function resolveCreds(account) {
  const saved = await vault.loadCreds(account.account_id);
  if (saved.ok && saved.creds && saved.creds.password) {
    const c = saved.creds;
    return { username: cleanHandle(c.username) || cleanHandle(account.handle), password: c.password, email: c.email || '', totpSecret: c.totp || '' };
  }
  return credsFor(account);
}

const NO_CREDS = {
  ok: false, code: 'no_credentials',
  error: 'No X password saved yet. Open Settings → X, enter the account password and tap Connect X.',
};

// ── pacing: one action at a time, with a human-ish gap ──────────────────────
let chain = Promise.resolve();
function serialised(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => sleep(gapMs() + Math.floor(Math.random() * Math.min(1500, gapMs()))), () => sleep(gapMs()));
  return run;
}

// ── sessions + clients ──────────────────────────────────────────────────────
const clients = new Map();   // account_id → { stamp, client }
const pending = new Map();   // account_id → { login, at }
const lastLogin = new Map(); // account_id → ms

const cookieString = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');

async function clientFor(account, session) {
  const L = await lib();
  const hit = clients.get(account.account_id);
  if (hit && hit.stamp === session.saved_at) return hit.client;
  const client = new L.TwitterHttpClient({
    cookies: cookieString(session.cookies),
    userAgent: session.user_agent || undefined,
    maxRetries: 2,
  });
  clients.set(account.account_id, { stamp: session.saved_at, client });
  return client;
}

async function signer() {
  const L = await lib();
  return (method, url) => L.getTransactionId(method, url, { fetch: globalThis.fetch });
}

async function persist(account, result, userAgent) {
  const saved = await vault.save(account.account_id, {
    cookies: result.cookies, user_agent: userAgent, user_id: result.userId || null, handle: cleanHandle(account.handle),
  });
  clients.delete(account.account_id);
  return saved;
}

function failFrom(e) {
  if (e instanceof XLoginError) return { ok: false, code: e.code, error: e.message };
  return { ok: false, code: 'login_failed', error: 'Sign-in failed: ' + (e && e.message ? e.message : String(e)) };
}

// ── login / connect ─────────────────────────────────────────────────────────
async function finishLogin(account, outcome, ua, login) {
  if (outcome.status === 'code_required') {
    pending.set(account.account_id, { login, at: Date.now() });
    return { ok: true, connected: false, needs_code: true, kind: outcome.kind, prompt: outcome.prompt };
  }
  pending.delete(account.account_id);
  const saved = await persist(account, outcome, ua);
  if (!saved.ok) return saved;
  return { ok: true, connected: true, stored_in: saved.where };
}

async function signIn(account) {
  const creds = await resolveCreds(account);
  if (!creds) return NO_CREDS;
  const L = await lib();
  const ua = (L.USER_AGENTS && L.USER_AGENTS[0]) || undefined;
  const login = new XLogin({ ...creds, userAgent: ua, sign: await signer() });
  lastLogin.set(account.account_id, Date.now());
  try {
    return await finishLogin(account, await login.run(), ua, login);
  } catch (e) { return failFrom(e); }
}

async function submitCode(account, code) {
  const p = pending.get(account.account_id);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(account.account_id);
    return { ok: false, code: 'no_pending', error: 'That sign-in timed out. Tap Connect to start again.' };
  }
  try {
    return await finishLogin(account, await p.login.submitCode(code), p.login.ua, p.login);
  } catch (e) {
    if (e instanceof XLoginError && e.code === 'bad_code') return failFrom(e);
    pending.delete(account.account_id);
    return failFrom(e);
  }
}

function hasPendingLogin(account) {
  const p = pending.get(account.account_id);
  if (p && Date.now() - p.at > PENDING_TTL_MS) { pending.delete(account.account_id); return false; }
  return !!p;
}

function pendingPrompt(account) {
  const p = pending.get(account.account_id);
  return p ? { kind: p.login.pending && p.login.pending.kind, prompt: p.login.pending && p.login.pending.prompt } : null;
}

// connect = make sure a working session exists: verify the saved one, else sign in.
async function connect(account) {
  if (account.platform !== PLATFORM) return { ok: false, code: 'unsupported_platform', error: `${account.platform} is not supported (X only).` };
  if (hasPendingLogin(account)) {
    const p = pendingPrompt(account);
    return { ok: true, connected: false, needs_code: true, kind: p.kind, prompt: p.prompt };
  }
  const v = await verify(account);
  if (v.ok && v.session.connected) return { ok: true, connected: true, detail: v.session.detail };
  if (!v.ok && v.code !== 'session_expired' && v.code !== 'no_session') return v;
  return signIn(account);
}

// ── errors from the vendored client → Ariana's codes ───────────────────────
function classify(e, L) {
  const E = (L && L.errors) || {};
  const status = e && e.status;
  const apiCode = e && e.data && Array.isArray(e.data.errors) && e.data.errors[0] && e.data.errors[0].code;
  if (E.RateLimitError && e instanceof E.RateLimitError) return { ok: false, code: 'rate_limited', error: 'X is rate-limiting this account right now. Try again later.' };
  if ([226, 326, 64, 141].includes(apiCode)) return { ok: false, code: 'challenge', error: 'X flagged the account (automation / locked / suspended). Open it once in the X app, clear the prompt, then try again.' };
  if ((E.AuthError && e instanceof E.AuthError) || status === 401 || status === 403 || [32, 89, 215].includes(apiCode)) {
    return { ok: false, code: 'session_expired', error: 'X says this login is no longer valid.' };
  }
  if (E.NotFoundError && e instanceof E.NotFoundError) return { ok: false, code: 'not_found', error: (e.message || 'Not found on X.') };
  if (E.NetworkError && e instanceof E.NetworkError) return { ok: false, code: 'unreachable', error: 'Could not reach X: ' + e.message };
  return { ok: false, code: 'action_failed', error: (e && e.message) || 'X did not accept that action.' };
}

// Run fn with an authenticated client. On an expired session, sign in again once and retry.
async function withClient(account, fn) {
  const L = await lib();
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await vault.load(account.account_id);
    if (!s.ok) return s;
    if (!s.session) return { ok: false, code: 'no_session', error: 'This account has no saved X login yet. Tap Connect on it.' };
    const client = await clientFor(account, s.session);
    try {
      return { ok: true, data: await fn(client, L, s.session) };
    } catch (e) {
      const c = classify(e, L);
      if (c.code !== 'session_expired' || attempt === 1) return c;
      const since = Date.now() - (lastLogin.get(account.account_id) || 0);
      if (since < reloginGapMs()) return { ...c, error: c.error + ' (A fresh sign-in was tried recently, so it is waiting before trying again.)' };
      const again = await signIn(account);
      if (!again.ok) return { ok: false, code: again.code, error: 'The X login expired and signing in again failed: ' + again.error };
      if (again.needs_code) return { ok: false, code: 'code_required', error: 'The X login expired and X wants a verification code. Open the Social screen and tap Connect.' };
    }
  }
  return { ok: false, code: 'session_expired', error: 'X says this login is no longer valid.' };
}

// ── CONTRACT ────────────────────────────────────────────────────────────────
function configured() { return true; }
function provider() { return 'x-lite'; }
function baseUrl() { return null; }
function configHint() { return 'The X engine runs inside Ariana. Add X_PASSWORD to the server environment and tap Connect.'; }

async function health() {
  const list = (await accounts.list()).filter((a) => a.platform === PLATFORM);
  let saved = 0;
  let loginConfigured = false;
  for (const a of list) {
    const s = await vault.load(a.account_id); if (s.ok && s.session) saved++;
    if (await resolveCreds(a)) loginConfigured = true;
  }
  return {
    ok: true,
    health: {
      provider: 'x-lite', engine: 'in-process (no browser)', status: 'ok',
      sessions: saved, accounts: list.length,
      session_storage: vault.available() ? (store.usingSupabase() ? 'supabase (encrypted)' : 'local file (encrypted)') : 'no encryption key',
      login_configured: loginConfigured,
    },
  };
}

async function capabilities() { return { ok: true, capabilities: { ...caps.describe(), provider: 'x-lite' } }; }

async function sessions() {
  const out = [];
  for (const a of (await accounts.list()).filter((x) => x.platform === PLATFORM)) {
    const s = await vault.load(a.account_id);
    out.push({ account_id: a.account_id, platform: a.platform, exists: !!(s.ok && s.session), connected: !!(s.ok && s.session), detail: s.ok ? (s.session ? 'Saved login found.' : 'No saved login yet.') : s.error });
  }
  return { ok: true, sessions: out };
}

async function sessionStatus(account) {
  const s = await vault.load(account.account_id);
  if (!s.ok) return s;
  return { ok: true, session: { exists: !!s.session, has_session: !!s.session, saved_at: s.session && s.session.saved_at } };
}

async function verify(account) {
  const r = await withClient(account, async (client, L, session) => {
    const me = await client.rest(L.REST.verifyCredentials, { method: 'GET' });
    return me;
  });
  if (!r.ok) {
    if (r.code === 'no_session') return { ok: true, session: { connected: false, exists: false, detail: r.error } };
    if (r.code === 'session_expired') return { ok: true, session: { connected: false, exists: true, detail: 'X no longer accepts the saved login.' }, code: 'session_expired' };
    return r;
  }
  const me = r.data || {};
  const handle = String(me.screen_name || '').toLowerCase();
  if (!handle) return { ok: true, session: { connected: false, exists: true, detail: 'X answered, but not as a signed-in user.' } };
  if (handle !== cleanHandle(account.handle).toLowerCase()) {
    return { ok: true, session: { connected: false, exists: true, detail: `The saved login is @${me.screen_name}, not @${cleanHandle(account.handle)}.` } };
  }
  return { ok: true, session: { connected: true, exists: true, detail: `Signed in as @${me.screen_name}.` } };
}

async function importSession() {
  return { ok: false, code: 'unsupported', error: 'Cookie import is not supported: Ariana signs in by itself with the saved X login.' };
}

async function disconnect(account) {
  pending.delete(account.account_id);
  clients.delete(account.account_id);
  const r = await vault.remove(account.account_id);
  await vault.removeCreds(account.account_id); // disconnect forgets the password too
  return r.ok ? { ok: true, result: { removed: true } } : { ok: false, code: 'store_failed', error: r.error };
}

// ── ACTIONS ─────────────────────────────────────────────────────────────────
const tweetIdOf = (u) => {
  const s = String(u || '').trim();
  const m = /status(?:es)?\/(\d+)/.exec(s) || /^(\d{6,})$/.exec(s);
  return m ? m[1] : null;
};
const need = (v, what) => { if (!v) { const e = new Error(what); e.userInput = true; throw e; } return v; };
const okFlag = (r) => { if (r && r.success === false) throw new Error('X did not accept that.'); return r; };

function profileData(p) {
  return {
    id: p.id || null, name: p.name || '', username: p.username || '', bio: p.bio || '',
    followers: p.followers ?? null, following: p.following ?? null,
    tweets: p.tweets ?? p.tweetCount ?? p.statusesCount ?? null, joined: p.joined || null, verified: !!(p.verified || p.isVerified),
  };
}

const urlFor = (handle, t) => {
  const id = t && (t.id || t.id_str || t.rest_id);
  return id ? { tweet_id: String(id), url: `https://x.com/${cleanHandle(handle)}/status/${id}` } : {};
};

const HANDLERS = {
  async view_profile(c, L, p) { return profileData(await L.scrapeProfile(c, cleanHandle(need(p.username, 'Which profile?')))); },
  async engagement(c, L, p) { return profileData(await L.scrapeProfile(c, cleanHandle(need(p.username, 'Which profile?')))); },
  async like(c, L, p) { okFlag(await L.likeTweet(c, need(tweetIdOf(p.url), 'That is not a tweet link.'))); return {}; },
  async repost(c, L, p) { okFlag(await L.retweet(c, need(tweetIdOf(p.url), 'That is not a tweet link.'))); return {}; },
  async comment(c, L, p, ctx) { return urlFor(ctx.handle, await L.replyToTweet(c, need(tweetIdOf(p.url), 'That is not a tweet link.'), need(p.text, 'No reply text.'))); },
  async reply(c, L, p, ctx) { return HANDLERS.comment(c, L, p, ctx); },
  async post(c, L, p, ctx) { return urlFor(ctx.handle, await L.postTweet(c, need(p.text, 'No post text.'))); },
  async follow(c, L, p) { okFlag(await L.followByUsername(c, cleanHandle(need(p.username, 'Who?')))); return {}; },
  async unfollow(c, L, p) {
    const who = await L.scrapeProfile(c, cleanHandle(need(p.username, 'Who?')));
    okFlag(await L.unfollowUser(c, need(who && who.id, 'Could not find that user.')));
    return {};
  },
  async dm(c, L, p) { const r = await L.sendDMByUsername(c, cleanHandle(need(p.username, 'Who?')), need(p.message, 'No message.')); return { message_id: r && r.messageId }; },
  async read_dms(c, L, _p, ctx) {
    const inbox = await L.getInbox(c, { limit: 20 });
    const me = String(ctx.userId || '');
    const items = [];
    for (const conv of (inbox && inbox.conversations) || []) {
      if (conv.type === 'group') continue;
      const other = (conv.participants || []).find((x) => String(x.id) !== me) || (conv.participants || [])[0];
      const text = conv.lastMessage && conv.lastMessage.text;
      if (!other || !other.username || !text) continue;
      const sender = conv.lastMessage.senderId ? String(conv.lastMessage.senderId) : '';
      items.push({ from: other.username, last_message: text, last_from_me: sender && me ? sender === me : null, unread: conv.unreadCount || 0 });
    }
    return { items };
  },
};

async function act(account, action, payload) {
  if (account.platform !== PLATFORM) return { ok: false, code: 'unsupported_platform', error: `${account.platform} is not supported (X only).` };
  const run = HANDLERS[action];
  if (!run) return { ok: false, code: 'unsupported', error: `${action} is not supported on X.` };
  const r = await serialised(() => withClient(account, async (client, L, session) => {
    try { return await run(client, L, payload || {}, { handle: account.handle, userId: session.user_id }); }
    catch (e) { if (e && e.userInput) return { __input: e.message }; throw e; }
  }));
  if (!r.ok) return r;
  if (r.data && r.data.__input) return { ok: false, code: 'bad_input', error: r.data.__input };
  return { ok: true, result: { success: true, ...r.data } };
}

module.exports = {
  configured, provider, baseUrl, configHint, health, capabilities, sessions, sessionStatus,
  verify, importSession, disconnect, act,
  connect, submitCode, hasPendingLogin, pendingPrompt, credsFor, resolveCreds,
  handledActions: () => Object.keys(HANDLERS),
  _setLibForTest: (l) => { _libOverride = l; clients.clear(); },
  _reset: () => { clients.clear(); pending.clear(); lastLogin.clear(); chain = Promise.resolve(); },
};
