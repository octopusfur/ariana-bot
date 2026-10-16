// social/ig_engine.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's hands on Instagram — through the Instagram service (ig-service/),
// which wraps instagrapi (Instagram's private mobile API, no browser).
//
// Same contract as x_engine.js: take (account, action, payload) from
// social/tools.js and either do it or say honestly why not. It never throws;
// every function resolves to { ok: true, ... } or { ok: false, code, error }.
//
//   · health(), sessions(), sessionStatus() answer locally and NEVER touch the
//     network — opening the dashboard must not wake a sleeping service.
//   · input is validated here BEFORE the service is contacted, so a bad request
//     costs nothing.
//   · only connection failures (the service waking up) are retried, and only for
//     reads and Connect. A write — like, comment, follow, DM — is sent exactly
//     once: a timeout there must never become a double comment.
//   · the pacing that makes her look like a person (pauses, gaps, daily caps,
//     cool-down after Instagram pushes back) lives in the service, next to the
//     session it protects.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const caps = require('./capabilities');
const store = require('./store');

const WAKE_BUDGET_MS = () => num(process.env.IG_SERVICE_WAKE_MS, 150000); // cold start can take ~1-2 min
const CALL_TIMEOUT_MS = () => num(process.env.IG_SERVICE_CALL_MS, 170000); // writes include human pauses
const RETRY_PAUSE_MS = () => num(process.env.IG_SERVICE_RETRY_PAUSE_MS, 4000);

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── CONFIG ──────────────────────────────────────────────────────────────────

function baseUrl() {
  const raw = (process.env.IG_SERVICE_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(raw) ? raw : null;
}

function apiKey() {
  return (process.env.IG_SERVICE_API_KEY || '').trim() || null;
}

// Both are required: an unauthenticated Instagram service must never be talked to.
function configured() {
  return !!baseUrl() && !!apiKey();
}

function handles(account) {
  return !!(account && account.platform === 'instagram' && configured());
}

const HINT = 'Set IG_SERVICE_URL (the Instagram service address) and IG_SERVICE_API_KEY (the same key the service uses). See ig-service/README.md.';

function notConfigured() {
  return { ok: false, code: 'not_configured', error: 'The Instagram service is not connected — ' + HINT };
}

// ── VALIDATION (local) ──────────────────────────────────────────────────────

const USER_RE = /^[A-Za-z0-9._]{1,30}$/;
const POST_RE = /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]{5,20}/i;

function normalizeUsername(value) {
  const u = String(value || '').trim().replace(/^@/, '');
  return USER_RE.test(u) ? u : null;
}

function isPostUrl(value) {
  return POST_RE.test(String(value || ''));
}

function badTarget(error) {
  return { ok: false, code: 'bad_target', error };
}

// action -> what must be true of the payload. Same names as capabilities.ig-api.json.
const HANDLERS = {
  view_profile: (p) => (normalizeUsername(p.username) ? null : 'That is not a valid Instagram username.'),
  engagement: (p) => (normalizeUsername(p.username) ? null : 'That is not a valid Instagram username.'),
  view_posts: (p) => (normalizeUsername(p.username) ? null : 'That is not a valid Instagram username.'),
  view_feed: () => null,
  read_dms: () => null,
  like: (p) => (isPostUrl(p.url) ? null : 'That is not an Instagram post or reel link.'),
  comment: (p) => (!isPostUrl(p.url) ? 'That is not an Instagram post or reel link.'
    : !String(p.text || '').trim() ? 'The comment is empty.' : null),
  follow: (p) => (normalizeUsername(p.username) ? null : 'That is not a valid Instagram username.'),
  unfollow: (p) => (normalizeUsername(p.username) ? null : 'That is not a valid Instagram username.'),
  dm: (p) => (!normalizeUsername(p.username) ? 'That is not a valid Instagram username.'
    : !String(p.message || '').trim() ? 'The message is empty.' : null),
  post: (p) => (!/^https:\/\/[^\s]+$/i.test(String(p.image_url || '').trim())
    ? 'Instagram posts need a picture — give a public https link to the image.' : null),
};

function supportedActions() { return Object.keys(HANDLERS); }

// The body the service expects for each action.
function bodyFor(action, p) {
  const out = { ...p };
  if (out.username) out.username = normalizeUsername(out.username);
  return out;
}

// ── SESSION (kept in Ariana's Supabase, handed to the service with each request) ───────────

const SESSION_TYPE = 'instagram';
const sessionKey = (handle) => String(handle || '').trim().replace(/^@/, '').toLowerCase();

async function storedSession(handle) {
  try {
    const d = await store.getSession(SESSION_TYPE, sessionKey(handle));
    return d && d.settings ? d : null;
  } catch (e) {
    return null;
  }
}

const NO_SESSION = { ok: false, code: 'no_session', error: 'Instagram is not connected yet. Open Settings → Connect Instagram and sign in once.' };

// ── HTTP ────────────────────────────────────────────────────────────────────

function isTransient(res, err) {
  if (err) {
    const name = err && (err.name || '');
    const m = String((err && err.message) || '') + String((err && err.cause && err.cause.code) || '');
    return !(name === 'TimeoutError' || name === 'AbortError') && /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(m);
  }
  return !!res && [502, 503, 504].includes(res.status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// retry=true: keep trying through a cold start. retry=false: exactly one attempt.
async function call(method, urlPath, body, { retry = false, timeoutMs = CALL_TIMEOUT_MS() } = {}) {
  if (!configured()) return notConfigured();
  const deadline = Date.now() + WAKE_BUDGET_MS();
  for (;;) {
    let res = null;
    let err = null;
    try {
      res = await fetch(baseUrl() + urlPath, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey() },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { err = e; }

    if (retry && isTransient(res, err) && Date.now() + RETRY_PAUSE_MS() < deadline) {
      await sleep(RETRY_PAUSE_MS());
      continue;
    }
    if (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return {
        ok: false,
        code: timedOut ? 'timeout' : 'unreachable',
        error: timedOut
          ? 'The Instagram service did not answer in time. The action may still have gone through — check before repeating it.'
          : `Cannot reach the Instagram service at ${baseUrl()} (${err.message}). It may be asleep or down.`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'unauthorized', error: 'The Instagram service rejected the API key — check IG_SERVICE_API_KEY matches the service.' };
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok || data === null) {
      return { ok: false, code: 'engine_error', error: `The Instagram service answered HTTP ${res.status} with something Ariana does not understand.` };
    }
    return { ok: true, data };
  }
}

// ── ACTIONS ─────────────────────────────────────────────────────────────────

async function act(account, action, payload) {
  if (!configured()) return notConfigured();
  const check = HANDLERS[action];
  if (!check) {
    return { ok: false, code: 'unsupported', error: `"${action}" is not something Ariana can do on Instagram through the Instagram service.` };
  }
  const p = payload || {};
  const bad = check(p);
  if (bad) return badTarget(bad); // validated before anything is contacted

  const sess = await storedSession(account && account.handle);
  if (!sess) return NO_SESSION;

  const isWrite = (caps.actionSpec(action) || {}).kind === 'write';
  const r = await call('POST', `/act/${encodeURIComponent(action)}`, { handle: account && account.handle, payload: bodyFor(action, p), session: { settings: sess.settings } }, { retry: !isWrite });
  if (!r.ok) return r;
  const out = r.data;
  if (!out || out.success !== true) {
    return { ok: false, code: (out && out.code) || 'action_failed', error: (out && out.error) || 'The Instagram service did not report success for that action.' };
  }
  return { ok: true, result: { success: true, platform: 'instagram', action, data: out.data } };
}

// ── STATUS (local; these must never wake the service) ───────────────────────

async function health() {
  if (!configured()) return notConfigured();
  return {
    ok: true,
    health: {
      provider: 'instagrapi',
      mode: 'on-demand',
      reachable: 'not checked',
      note: 'The Instagram service is only contacted when an action runs or you press Connect, so this is not a live check.',
    },
  };
}

async function sessions() {
  return { ok: true, sessions: [] };
}

async function sessionStatus(account) {
  if (!configured()) return notConfigured();
  const sess = await storedSession(account && account.handle);
  return { ok: true, session: sess
    ? { exists: true, has_session: true, detail: 'Signed in earlier — press Connect to check it is still live.' }
    : { exists: false, has_session: false, detail: 'Not signed in yet. Open Settings → Connect Instagram.' } };
}

// The one deliberate round trip: user-initiated, proves the key, the session and
// which Instagram account the service is really signed in as.
async function verify(account) {
  if (!configured()) return notConfigured();
  const sess = await storedSession(account && account.handle);
  if (!sess) return { ok: true, session: { connected: false, detail: 'Not signed in yet. Open Settings → Connect Instagram.' } };
  const r = await call('POST', '/verify', { handle: account && account.handle, session: { settings: sess.settings } }, { retry: true });
  if (!r.ok) return r;
  const d = r.data || {};
  return { ok: true, session: { connected: d.connected === true, detail: d.detail || (d.connected ? 'Verified live.' : 'The service could not confirm the session.') } };
}

// Sign in once from the dashboard form. The password goes to the service for this single call and is
// never stored or logged on either side; only the resulting session is kept (Supabase).
async function login(username, password, code) {
  if (!configured()) return notConfigured();
  const handle = normalizeUsername(username);
  if (!handle || !password) return { ok: false, code: 'bad_input', error: 'Enter the Instagram username and password.' };
  const r = await call('POST', '/login', { username: handle, password: String(password), code: code ? String(code).trim() : undefined }, { retry: true, timeoutMs: 120000 });
  if (!r.ok) return r;
  const d = r.data || {};
  if (d.connected !== true || !d.settings) {
    return { ok: true, connected: false, code: d.code || 'login_failed', detail: d.detail || 'Instagram did not accept that sign-in.' };
  }
  const who = sessionKey(d.handle || handle);
  try {
    await store.setSession(SESSION_TYPE, who, { settings: d.settings, saved_at: new Date().toISOString() });
  } catch (e) {
    return { ok: false, code: 'save_failed', error: `Signed in, but the session could not be saved to the database (${e.message}). Check Supabase.` };
  }
  return { ok: true, connected: true, handle: who, detail: d.detail || `Signed in as @${who}.` };
}

// Latest messages in her inbox, for the DM poller.
async function inbox(account, { includeRequests = false } = {}) {
  if (!configured()) return notConfigured();
  const sess = await storedSession(account && account.handle);
  if (!sess) return NO_SESSION;
  const r = await call('POST', '/inbox', { handle: account.handle, session: { settings: sess.settings }, include_requests: !!includeRequests }, { retry: true, timeoutMs: 90000 });
  if (!r.ok) return r;
  const d = r.data || {};
  if (d.success !== true) return { ok: false, code: d.code || 'inbox_failed', error: d.error || 'Could not read the inbox.' };
  return { ok: true, threads: d.threads || [] };
}

async function importSession() {
  return { ok: false, code: 'unsupported', error: 'Sign in from Settings → Connect Instagram — there is nothing to import.' };
}

async function disconnect(account) {
  try { await store.deleteSession(SESSION_TYPE, sessionKey(account && account.handle)); } catch (e) {
    return { ok: false, code: 'delete_failed', error: e.message };
  }
  return { ok: true, result: { deleted: true } };
}

module.exports = {
  configured, handles, baseUrl, apiKey, HINT,
  health, sessions, sessionStatus, verify, importSession, disconnect, act, login, inbox,
  // exposed for tests
  supportedActions, normalizeUsername, isPostUrl, isTransient,
};
