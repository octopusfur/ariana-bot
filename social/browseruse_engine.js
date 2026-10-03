// social/browseruse_engine.js
// ─────────────────────────────────────────────────────────────────────────────
// The social engine, backed by Browser Use Cloud (https://browser-use.com).
//
// Why this exists: the original engine (socialcrabs-service) needs its own server and a
// laptop to sign accounts in. This adapter needs only BROWSER_USE_API_KEY. A Browser Use
// *profile* holds each account's login (cookies), a *task* is one browser action.
//
// Same contract as engine_client.js: every function returns { ok:true, ... } or
// { ok:false, error, code } and never throws. All of Ariana's guards (per-account switch,
// rate limits, confirmations, dry run) still run BEFORE anything reaches this file.
//
// No passwords: the creator signs in themselves through Browser Use's live browser view.
// Ariana never sees or stores a credential, and the tasks forbid typing one.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const WebSocket = require('ws');
const caps = require('./capabilities');

const BASE = 'https://api.browser-use.com/api/v2';
const PROXY = (process.env.BROWSER_USE_PROXY_COUNTRY || 'us').toLowerCase();
const ACTION_GAP_MS = Number(process.env.SOCIAL_ACTION_GAP_MS || 10000);
const LOGIN_MINUTES = 30;

const SITE = {
  instagram: { label: 'Instagram', home: 'https://www.instagram.com/', login: 'https://www.instagram.com/accounts/login/', domain: 'instagram.com' },
  twitter:   { label: 'X (Twitter)', home: 'https://x.com/home', login: 'https://x.com/i/flow/login', domain: 'x.com' },
  linkedin:  { label: 'LinkedIn', home: 'https://www.linkedin.com/feed/', login: 'https://www.linkedin.com/login', domain: 'linkedin.com' },
};

const apiKey = () => (process.env.BROWSER_USE_API_KEY || '').trim();
const configured = () => !!apiKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ────────────────────────────────────────────────────────────────────
async function bu(method, path, body, { timeoutMs = 30000 } = {}) {
  if (!configured()) return { ok: false, code: 'not_configured', error: 'Set BROWSER_USE_API_KEY to use Browser Use as the social engine.' };
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'X-Browser-Use-API-Key': apiKey(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized', status: res.status, error: 'Browser Use rejected the API key. Check BROWSER_USE_API_KEY.' };
    if (res.status === 402) return { ok: false, code: 'no_credits', status: 402, error: 'Browser Use is out of credits (or the key hit its spend limit). Top up at cloud.browser-use.com.' };
    if (res.status === 429) return { ok: false, code: 'busy', status: 429, error: 'Browser Use has too many browsers running at once. Try again in a minute.' };
    if (!res.ok) {
      const d = data && data.detail;
      const msg = typeof d === 'string' ? d : (d && d.message) || (data && data.error) || `Browser Use returned HTTP ${res.status}.`;
      return { ok: false, code: 'engine_error', status: res.status, error: msg };
    }
    return { ok: true, data };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, code: timedOut ? 'timeout' : 'unreachable', error: timedOut ? 'Browser Use did not answer in time.' : `Cannot reach Browser Use (${e.message}).` };
  }
}

// ── PROFILES (one per account; the profile IS the saved login) ──────────────
const profileName = (account) => `ariana-${String(account.account_id).replace(/[^a-z0-9._-]+/gi, '-')}`;

async function findProfile(account) {
  const name = profileName(account);
  for (let page = 1; page <= 5; page++) {
    const r = await bu('GET', `/profiles?pageSize=100&pageNumber=${page}`);
    if (!r.ok) return r;
    const items = (r.data && (r.data.items || r.data.profiles)) || [];
    const hit = items.find((p) => p.name === name);
    if (hit) return { ok: true, profile: hit };
    if (items.length < 100) break;
  }
  return { ok: true, profile: null };
}

async function ensureProfile(account) {
  const found = await findProfile(account);
  if (!found.ok) return found;
  if (found.profile) return { ok: true, profile: found.profile };
  const made = await bu('POST', '/profiles', { name: profileName(account) });
  if (!made.ok) return made;
  return { ok: true, profile: made.data };
}

// ── LOGIN (the creator signs in on Browser Use's live browser) ──────────────
const pendingLogins = new Map(); // account_id -> { browserId, liveUrl, startedAt }

// Best effort: send the live browser to the login page so the creator doesn't have to type a URL.
async function cdpNavigate(cdpUrl, url) {
  const base = String(cdpUrl).replace(/\/+$/, '');
  const ver = await fetch(base + '/json/version', { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
  const wsUrl = ver.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('no debugger url');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const send = (method, params, sessionId) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('cdp timeout')); }, 20000);
    ws.on('message', (m) => {
      let msg; try { msg = JSON.parse(m); } catch (_) { return; }
      const p = msg.id && pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('open', async () => {
      try {
        const { targetInfos } = await send('Target.getTargets', {});
        const page = (targetInfos || []).find((t) => t.type === 'page');
        if (!page) throw new Error('no page target');
        const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        await send('Page.navigate', { url }, sessionId);
        clearTimeout(timer); ws.close(); resolve();
      } catch (e) { clearTimeout(timer); try { ws.close(); } catch (_) {} reject(e); }
    });
  });
}

function hasPendingLogin(account) {
  const p = pendingLogins.get(account.account_id);
  if (p && Date.now() - p.startedAt > LOGIN_MINUTES * 60000) { pendingLogins.delete(account.account_id); return false; }
  return !!p;
}

async function startLogin(account) {
  const site = SITE[account.platform];
  if (!site) return { ok: false, code: 'unsupported', error: `No browser login flow for ${account.platform}.` };
  const prof = await ensureProfile(account);
  if (!prof.ok) return prof;
  const b = await bu('POST', '/browsers', { profileId: prof.profile.id, proxyCountryCode: PROXY, timeout: LOGIN_MINUTES, browserScreenWidth: 430, browserScreenHeight: 900 });
  if (!b.ok) return b;
  const liveUrl = b.data.liveUrl;
  pendingLogins.set(account.account_id, { browserId: b.data.id, liveUrl, startedAt: Date.now() });
  let navigated = false;
  if (b.data.cdpUrl) { try { await cdpNavigate(b.data.cdpUrl, site.login); navigated = true; } catch (e) { console.warn('[social/bu] could not open the login page for you:', e.message); } }
  return { ok: true, live_url: liveUrl, navigated, login_page: site.login };
}

// Stopping the browser is what makes Browser Use save the profile's cookies.
async function finishLogin(account) {
  const p = pendingLogins.get(account.account_id);
  if (!p) return { ok: true };
  pendingLogins.delete(account.account_id);
  const r = await bu('PATCH', `/browsers/${p.browserId}`, { action: 'stop' });
  if (!r.ok && r.status !== 404 && r.status !== 400) return r;
  await sleep(4000); // let the profile finish saving
  return { ok: true };
}

// ── TASKS ───────────────────────────────────────────────────────────────────
let chain = Promise.resolve();
let lastRunAt = 0;
// Browser actions run one at a time with a human-paced gap — never in parallel.
function serialised(fn) {
  const run = chain.then(async () => {
    const wait = lastRunAt + ACTION_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastRunAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

const RESULT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    code: { type: 'string' },
    error: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
  },
  required: ['success'],
});

function parseJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

async function runTask({ task, profileId, startUrl, maxSteps = 40, timeoutMs = 170000 }) {
  const created = await bu('POST', '/tasks', {
    task,
    startUrl: startUrl || undefined,
    maxSteps,
    structuredOutput: RESULT_SCHEMA,
    sessionSettings: { profileId, proxyCountryCode: PROXY },
  }, { timeoutMs: 45000 });
  if (!created.ok) return created;
  const id = created.data.id;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    const t = await bu('GET', `/tasks/${id}`);
    if (!t.ok) { if (t.code === 'timeout' || t.code === 'unreachable') continue; return t; }
    const status = String((t.data && t.data.status) || '').toLowerCase();
    if (['finished', 'stopped', 'failed', 'error', 'completed'].includes(status)) {
      return { ok: true, task: t.data, parsed: parseJson(t.data.output) };
    }
  }
  await bu('PATCH', `/tasks/${id}`, { action: 'stop_task_and_session' });
  return { ok: false, code: 'timeout', error: 'The browser action took too long and was stopped.' };
}

const RULES = (site, handle) => [
  `You are using the ${site.label} account @${handle}. The browser is already signed in.`,
  'Do exactly ONE job, described below, and nothing else. Stay on ' + site.domain + '.',
  'NEVER type, request or accept a password, verification code or any credential.',
  'If you hit a login page, "confirm it\'s you" step or CAPTCHA you cannot pass, stop at once and report success=false with code "session_expired" (login) or "challenge" (checkpoint).',
  'Reply ONLY with JSON: {"success": true|false, "code": "...", "error": "...", "data": {...}}.',
].join(' ');

function instruction(action, p, platform) {
  const q = (v) => JSON.stringify(String(v == null ? '' : v));
  switch (action) {
    case 'search': return `Search for posts about ${q(p.query)}. Put up to 8 results in data.posts as [{"url","author","text"}].`;
    case 'view_profile': return `Open the profile of ${q(p.username)}. Put name, bio/headline, followers and following/connections (when shown) in data.`;
    case 'view_posts': return `Open the profile of ${q(p.username)} and put the URLs of their 10 most recent posts in data.posts as an array of strings.`;
    case 'view_feed': return 'Read the home feed. Put up to 10 posts in data.posts as [{"url","author","text"}]. Do not interact with anything.';
    case 'like': return `Open ${q(p.url)} and like the post. If it is already liked, leave it liked. Do nothing else.`;
    case 'comment':
    case 'reply': return `Open ${q(p.url)} and post this exact text as a ${platform === 'twitter' ? 'reply' : 'comment'}: ${q(p.text)}. Do not change the wording.`;
    case 'follow': return `Open the profile of ${q(p.username)} and follow them. If you already follow them, change nothing.`;
    case 'unfollow': return `Open the profile of ${q(p.username)} and unfollow them.`;
    case 'connect': return `Open ${q(p.profileUrl)} and send a connection request${p.note ? ' with this exact note: ' + q(p.note) : ' without a note'}.`;
    case 'dm': return `Send this exact direct message to ${q(p.username)}: ${q(p.message)}.`;
    case 'post': return platform === 'instagram'
      ? null
      : `Create a new post with exactly this text: ${q(p.text)}, and publish it. Put the post URL in data.url if you can see it.`;
    case 'repost': return `Open ${q(p.url)} and repost / share it to your own profile with no added text.`;
    case 'notifications': return 'Open notifications and put the latest 10 in data.items as [{"text","url"}]. Do not interact with anything.';
    case 'read_dms': return 'Open the inbox and put the 10 most recent conversations in data.items as [{"from","last_message"}]. Do not reply and do not open requests.';
    case 'engagement': return `Open the profile of ${q(p.username)} and put the likes/comments counts of their 5 latest posts in data.items.`;
    case 'delete_post': return `Open ${q(p.url)} and delete your own post.`;
    case 'delete_comment': return `Open ${q(p.url)} and delete your own comment.`;
    default: return null;
  }
}

// ── CONTRACT (same names as engine_client.js) ───────────────────────────────
async function health() {
  const r = await bu('GET', '/billing/account', undefined, { timeoutMs: 15000 });
  if (!r.ok) return r;
  return { ok: true, health: { engine: 'browser-use-cloud', status: 'ok', billing: r.data && { credits: r.data.totalCreditsBalanceUsd, concurrent_limit: r.data.concurrentSessionLimit } } };
}

async function capabilities() {
  const manifest = typeof caps.manifest === 'function' ? caps.manifest() : (caps.raw || null);
  if (manifest) return { ok: true, capabilities: manifest };
  return { ok: true, capabilities: { provider: 'browser-use-cloud', platforms: Object.keys(SITE) } };
}

async function sessions() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await bu('GET', `/profiles?pageSize=100&pageNumber=${page}`);
    if (!r.ok) return r;
    const items = (r.data && (r.data.items || r.data.profiles)) || [];
    for (const p of items) if (String(p.name || '').startsWith('ariana-')) out.push({ profile: p.name, id: p.id, exists: true });
    if (items.length < 100) break;
  }
  return { ok: true, sessions: out };
}

async function sessionStatus(account) {
  const f = await findProfile(account);
  if (!f.ok) return f;
  return { ok: true, session: { exists: !!f.profile, has_session: !!f.profile, pending_login: hasPendingLogin(account) } };
}

// Opens the platform with the saved login and checks it is really signed in.
async function verify(account) {
  const site = SITE[account.platform];
  if (!site) return { ok: false, code: 'unsupported', error: `Unsupported platform ${account.platform}.` };
  const f = await findProfile(account);
  if (!f.ok) return f;
  if (!f.profile) return { ok: true, session: { connected: false, detail: 'No saved login yet.' } };
  const task = `Open ${site.home}. ${RULES(site, account.handle)} Job: check only whether the account is signed in. Do not click anything. Return success=true with data.logged_in=true|false, and data.handle = the username shown for the signed-in account if visible.`;
  const r = await serialised(() => runTask({ task, profileId: f.profile.id, startUrl: site.home, maxSteps: 12, timeoutMs: 120000 }));
  if (!r.ok) return r;
  const d = (r.parsed && r.parsed.data) || {};
  if (r.parsed && r.parsed.success && d.logged_in === true) {
    const shown = d.handle ? String(d.handle).replace(/^@/, '').toLowerCase() : '';
    const wanted = String(account.handle || '').toLowerCase();
    if (shown && wanted && shown !== wanted) {
      return { ok: true, session: { connected: false, detail: `Signed in as @${shown}, not @${wanted}. Reconnect and sign in to the right account.` } };
    }
    return { ok: true, session: { connected: true, detail: 'Signed in (checked live in a Browser Use browser).' } };
  }
  return { ok: true, session: { connected: false, detail: (r.parsed && r.parsed.error) || 'The saved login is not signed in. Tap Connect and sign in again.' } };
}

async function importSession() {
  return { ok: false, code: 'unsupported', error: 'Browser Use signs in through its live browser. Tap Connect on the account instead of importing cookies.' };
}

async function disconnect(account) {
  pendingLogins.delete(account.account_id);
  const f = await findProfile(account);
  if (!f.ok) return f;
  if (!f.profile) return { ok: true, result: { deleted: false } };
  const r = await bu('DELETE', `/profiles/${f.profile.id}`);
  if (!r.ok && r.status !== 404) return r;
  return { ok: true, result: { deleted: true } };
}

async function act(account, action, payload) {
  const site = SITE[account.platform];
  if (!site) return { ok: false, code: 'unsupported', error: `Unsupported platform ${account.platform}.` };
  const job = instruction(action, payload || {}, account.platform);
  if (!job) return { ok: false, code: 'unsupported', error: `${action} is not supported on ${site.label} through the browser.` };
  const f = await findProfile(account);
  if (!f.ok) return f;
  if (!f.profile) return { ok: false, code: 'no_session', error: 'This account has no saved login yet. Tap Connect on it first.' };

  const task = `${RULES(site, account.handle)} Job: ${job}`;
  const r = await serialised(() => runTask({ task, profileId: f.profile.id, startUrl: site.home }));
  if (!r.ok) return r;
  const out = r.parsed;
  if (!out) return { ok: false, code: 'action_failed', error: 'The browser finished but did not report a clear result, so it is not counted as done.' };
  if (out.success !== true) return { ok: false, code: out.code || 'action_failed', error: out.error || 'The browser could not complete that action.', result: out };
  return { ok: true, result: { success: true, ...(out.data || {}) } };
}

module.exports = {
  configured, health, capabilities, sessions, sessionStatus, verify, importSession, disconnect, act,
  hasPendingLogin, startLogin, finishLogin,
};
