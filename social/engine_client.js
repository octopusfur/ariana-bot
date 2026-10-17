// social/engine_client.js
// ─────────────────────────────────────────────────────────────────────────────
// The one seam between Ariana's social layer (guards, tools, autonomy, dashboard) and whatever actually
// talks to a platform. It routes by platform:
//
//   X (twitter)   → x_engine.js     built in, plain HTTP, no browser, no extra service, no paid X API
//   Instagram     → ig_engine.js    the Instagram service (ig-service/, instagrapi) — no browser
//   TikTok        → browseruse_engine.js   Browser Use Cloud, opt-in only (TIKTOK_VIA_BROWSER_USE=on)
//   anything else → refused plainly (unsupported_platform)
//
// Every function resolves { ok: true, ... } or { ok: false, error, code } and never throws, so a failing
// platform degrades to a message, never to a broken conversation.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const x = require('./x_engine');
const bu = require('./browseruse_engine'); // TikTok only (X no longer uses it)
const inbound = require('./dm_inbound');
const ig = require('./ig_engine');

function routesToIG(account) { return ig.handles(account); }
function routesToX(account) { return !!account && account.platform === 'twitter'; }
function routesToBU(account) { return !!account && account.platform === 'tiktok' && bu.configured(); }

const unsupported = (account) => ({
  ok: false,
  code: 'unsupported_platform',
  error: `${(account && account.platform) || 'That platform'} is not available here. Supported: X, Instagram (when its service is set up) and TikTok (when switched on).`,
});

function tiktokLive() {
  try { return require('./capabilities').platformIds().includes('tiktok'); } catch (_) { return false; }
}

function provider() { return x.provider(); }
function configured() { return true; } // X is built in
function configHint() { return x.configHint(); }
function baseUrl() { return null; }
function apiKey() { return null; }

// ── STATUS ──────────────────────────────────────────────────────────────────

async function health() { return x.health(); }
async function capabilities() { return x.capabilities(); }

// Engine-side view of the sessions each engine holds. Used to reconcile statuses.
// Instagram is answered locally by the dashboard (it must not wake the service); TikTok's Browser Use
// profiles are only listed when TikTok is switched on.
async function sessions() {
  const out = [...(((await x.sessions()).sessions) || [])];
  if (bu.configured() && tiktokLive()) {
    const r = await bu.sessions();
    if (r && r.ok) out.push(...(r.sessions || []));
  }
  return { ok: true, sessions: out };
}

// ── SESSION LIFECYCLE ───────────────────────────────────────────────────────

async function sessionStatus(account) {
  if (routesToX(account)) return x.sessionStatus(account);
  if (routesToIG(account)) return ig.sessionStatus(account);
  if (routesToBU(account)) return bu.sessionStatus(account);
  return unsupported(account);
}

async function verify(account) {
  if (routesToX(account)) return x.verify(account);
  if (routesToIG(account)) return ig.verify(account);
  if (routesToBU(account)) return bu.verify(account);
  return unsupported(account);
}

async function importSession(account, session) {
  if (routesToX(account)) return x.importSession(account, session);
  if (routesToIG(account)) return ig.importSession(account, session);
  if (routesToBU(account)) return bu.importSession(account, session);
  return unsupported(account);
}

async function disconnect(account) {
  if (routesToX(account)) return x.disconnect(account);
  if (routesToIG(account)) return ig.disconnect(account);
  if (routesToBU(account)) return bu.disconnect(account);
  return { ok: true, result: { removed: false } }; // nothing was ever held for an unsupported platform
}

// X signs in by itself (and may ask for a one-time code). Instagram and TikTok connect through their own flows.
async function connect(account) {
  if (routesToX(account)) return x.connect(account);
  return unsupported(account);
}
async function submitCode(account, code) {
  if (routesToX(account)) return x.submitCode(account, code);
  return unsupported(account);
}
function hasPendingLogin(account) { return routesToX(account) ? x.hasPendingLogin(account) : false; }

// ── ACTIONS ─────────────────────────────────────────────────────────────────

// payload is the action's platform payload: { url } | { url, text } | { username } | { username, message } | { text } …
// She never starts a conversation on Instagram or TikTok: a DM goes out only to someone who already wrote to
// her. `reply: true` is for the DM poller answering an inbound message itself.
const NEVER_FIRST = new Set(['instagram', 'tiktok']);

async function act(account, action, payload, { reply = false } = {}) {
  if (action === 'dm' && account && NEVER_FIRST.has(account.platform) && !reply) {
    const who = payload && payload.username;
    if (!(await inbound.hasInbound(account.platform, who))) {
      return { ok: false, code: 'no_first_dm', error: `@${String(who || '').replace(/^@/, '')} has not messaged her first, and she never starts a conversation. Nothing was sent.` };
    }
  }
  if (routesToX(account)) return x.act(account, action, payload);
  if (routesToIG(account)) return ig.act(account, action, payload);
  if (routesToBU(account)) return bu.act(account, action, payload);
  return unsupported(account);
}

module.exports = {
  provider, bu, ig, x,
  routesToIG, routesToX, routesToBU,
  configured, configHint, baseUrl, apiKey,
  health, capabilities, sessions, sessionStatus, verify, importSession, disconnect,
  connect, submitCode, hasPendingLogin,
  act,
};
