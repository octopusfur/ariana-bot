// tests/social-brain.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's side of the social layer, without a browser anywhere in sight.
//
// The other suites cover the contract (manifest, guards, tools) and the engine
// adapter. This one covers the wiring between them:
//
//   · store    — accounts, permissions, activity and autonomy config survive a
//                restart; activity is capped and newest-first;
//   · activity — every entry is a sentence a person could read, and the counter
//                the daily limits rely on only counts things that happened;
//   · accounts — multi-account resolution never guesses, and the prompt block
//                tells her the truth about her own hands;
//   · autonomy — off until the creator turns it on, only ever looks at real
//                reads, never acts on a disabled account, and can always say no;
//   · api      — the dashboard routes are behind the same gate as /api/talk,
//                report "brands not connected" honestly, and mint confirmations
//                that only a human can create;
//   · index    — she is offered no tools at all when there is nothing to act
//                through, and her prompt says why.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-social-'));
process.env.SOCIAL_DATA_DIR = path.join(TMP, 'data');
process.env.X_SESSION_KEY = 'brain-test-key';
for (const k of ['X_PASSWORD', 'X_USERNAME', 'X_EMAIL', 'X_TOTP_SECRET', 'X_CREDENTIALS']) delete process.env[k];
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SOCIAL_DRY_RUN;

const social = require('../social');
const accounts = require('../social/accounts');
const activity = require('../social/activity');
const store = require('../social/store');
const autonomy = require('../social/autonomy');
const guards = require('../social/guards');
const tools = require('../social/tools');

// Reloads every social module, the way a redeploy would, so persistence can be
// tested for real rather than against an in-memory cache.
function restartSocial() {
  for (const file of Object.keys(require.cache)) {
    if (file.includes(`${path.sep}social${path.sep}`)) delete require.cache[file];
  }
  return {
    social: require('../social'),
    accounts: require('../social/accounts'),
    activity: require('../social/activity'),
    store: require('../social/store'),
    autonomy: require('../social/autonomy'),
    guards: require('../social/guards'),
    tools: require('../social/tools'),
  };
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ── STORE ───────────────────────────────────────────────────────────────────

test('store: with no Supabase configured it says so and keeps state in files', async () => {
  assert.equal(store.usingSupabase(), false);
  assert.ok(store.DATA_DIR.startsWith(TMP), 'the data dir is honoured');
});

test('store: accounts, permissions and activity survive a restart', async () => {
  const first = restartSocial();
  const added = await first.accounts.add({ platform: 'twitter', handle: '@ariana_personal', label: 'Personal' });
  assert.equal(added.ok, true);
  await first.accounts.setActionsEnabled(added.account.account_id, true);
  await first.activity.record({ account: added.account, action: 'like', target: 'https://x.com/someone/status/1', status: 'completed' });

  const second = restartSocial();
  const list = await second.accounts.list();
  assert.equal(list.length, 1, 'the register survived');
  assert.equal(list[0].account_id, 'twitter:ariana_personal');
  assert.equal(list[0].actions_enabled, true, 'the creator switch survived');
  const rows = await second.activity.recent(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'like');

  // The activity file is private and the accounts file is not world-readable.
  const mode = fs.statSync(path.join(store.DATA_DIR, 'accounts.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'the register is written 0600');
});

test('store: newest activity first, reads capped', async () => {
  const { activity: a, accounts: acc } = restartSocial();
  const account = (await acc.list())[0];
  for (let i = 0; i < 5; i++) {
    await a.record({ account, action: 'view_profile', target: `user${i}`, status: 'completed' });
  }
  const rows = await a.recent(3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].summary.includes('user4'), true, 'the newest entry comes first');
});

// ── ACTIVITY ────────────────────────────────────────────────────────────────

test('activity: every status reads as a sentence, never as a server log', () => {
  const cases = [
    ['completed', 'like', 'Liked @someone\'s post'],
    ['failed', 'like', 'Could not like @someone\'s post'],
    ['blocked', 'follow', 'Could not follow @someone — stopped by a limit or permission'],
    ['needs_confirmation', 'dm', 'DM to @someone failed — waiting for your confirmation'],
    ['unsupported', 'post', 'Posting failed — not supported by X'],
    ['skipped', 'like', 'Liked @someone\'s post — skipped (nothing was sent)'],
    ['partial', 'comment', 'Commented on @someone\'s post — partly done'],
  ];
  for (const [status, action, expected] of cases) {
    const row = { status, action, target_handle: '@someone', target: null, platform: 'twitter', error: 'Stack: TypeError at line 42' };
    assert.equal(activity.buildSummary(row), expected, status);
  }
  // The failure line never carries the raw error text.
  const failed = activity.buildSummary({ status: 'failed', action: 'like', target_handle: 'someone', platform: 'twitter', error: 'TimeoutError: waiting for selector' });
  assert.equal(/TimeoutError|selector/.test(failed), false);
});

test('activity: a noisy error is clamped to one readable line', () => {
  const noisy = "Cannot find module 'undici'\nRequire stack:\n- /app/social/x_engine.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1433)";
  assert.equal(activity.clampError(noisy), "Cannot find module 'undici'");
  assert.equal(activity.clampError(''), null);
  assert.equal(activity.clampError(null), null);
  const wall = 'x'.repeat(900);
  assert.equal(activity.clampError(wall).length, 400);
  assert.ok(activity.clampError(wall).endsWith('…'));

  // Until an old row scrolls away, the dashboard must not print a stack either.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /socReasonText\(e\.error\)/);
  assert.match(html, /function socReasonText/);
});

test('activity: a URL target is shortened, a missing one says nothing', () => {
  const withUrl = activity.buildSummary({ status: 'completed', action: 'like', target: 'https://x.com/someone/status/1234567890', platform: 'twitter' });
  assert.equal(withUrl, 'Liked a post');
  assert.equal(activity.buildSummary({ status: 'completed', action: 'search', target: 'ai agents', platform: 'twitter' }), 'Searched for "ai agents"');
  assert.equal(activity.buildSummary({ status: 'completed', action: 'post', platform: 'twitter' }), 'Published a post');
});

test('activity: the daily counter only counts things that really happened', async () => {
  const { activity: a, accounts: acc } = restartSocial();
  const account = (await acc.list())[0];
  const before = await a.countSince(24 * 60 * 60 * 1000, { accountId: account.account_id, action: 'comment' });

  await a.record({ account, action: 'comment', target: 'x', status: 'blocked', error: 'daily limit reached' });
  await a.record({ account, action: 'comment', target: 'x', status: 'needs_confirmation' });
  await a.record({ account, action: 'comment', target: 'x', status: 'unsupported' });
  await a.record({ account, action: 'comment', target: 'x', status: 'skipped' });
  const still = await a.countSince(24 * 60 * 60 * 1000, { accountId: account.account_id, action: 'comment' });
  assert.equal(still, before, 'blocked/needs_confirmation/unsupported/skipped never count');

  await a.record({ account, action: 'comment', target: 'x', status: 'completed' });
  await a.record({ account, action: 'comment', target: 'x', status: 'partial' });
  const after = await a.countSince(24 * 60 * 60 * 1000, { accountId: account.account_id, action: 'comment' });
  assert.equal(after, before + 2, 'completed and partial both spent real actions');
});

// ── ACCOUNTS ────────────────────────────────────────────────────────────────

test('accounts: several accounts on the platform, each with its own state', async () => {
  const { accounts: acc } = restartSocial();
  await acc.add({ platform: 'twitter', handle: 'ariana_creator' });
  await acc.add({ platform: 'twitter', handle: 'ArianaReyes' });

  const list = await acc.list();
  assert.equal(list.filter((a) => a.platform === 'twitter').length, 3);
  assert.equal(list.find((a) => a.account_id === 'twitter:arianareyes').handle, 'ArianaReyes');

  await acc.setStatus('twitter:ariana_creator', acc.STATUS.ONLINE, 'verified');
  await acc.setActionsEnabled('twitter:ariana_creator', true);
  const other = await acc.get('twitter:ariana_personal');
  assert.equal(other.status, 'not_connected', 'statuses do not bleed between accounts');
  assert.equal(other.actions_enabled, true);
});

test('accounts: an unknown platform is refused with the supported list', async () => {
  const { accounts: acc } = restartSocial();
  for (const platform of ['tiktok', 'instagram', 'linkedin']) {
    const out = await acc.add({ platform, handle: 'someone' });
    assert.equal(out.ok, false, platform);
    assert.match(out.error, new RegExp(`Unknown platform "${platform}"`));
    assert.match(out.error, /Supported: twitter/);
  }
});

test('accounts: resolution names the candidates instead of picking one', async () => {
  const { accounts: acc } = restartSocial();

  const byId = await acc.resolve('twitter:ariana_personal');
  assert.equal(byId.ok, true);
  assert.equal(byId.account.handle, 'ariana_personal');

  const byHandle = await acc.resolve('@ArianaReyes');
  assert.equal(byHandle.ok, true);
  assert.equal(byHandle.account.platform, 'twitter');

  const ambiguous = await acc.resolve('ariana');
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'ambiguous_account');
  assert.match(ambiguous.error, /twitter:ariana_personal/);
  assert.match(ambiguous.error, /twitter:ariana_creator/);

  const scoped = await acc.resolve('ariana_creator', 'twitter');
  assert.equal(scoped.ok, true);

  const nothing = await acc.resolve(null);
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'account_required');

  const missing = await acc.resolve('nobody');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'account_not_found');
});

test('accounts: the prompt says who is usable and who is switched off', async () => {
  const { accounts: acc } = restartSocial();
  await acc.setStatus('twitter:ariana_personal', acc.STATUS.ERROR, 'X says this login is no longer valid.');
  const text = await acc.describeForPrompt();
  assert.match(text, /X @ariana_personal \(account_id: twitter:ariana_personal\) — not usable right now/);
  assert.match(text, /X @ariana_creator.*connected/);
  assert.match(text, /X @ArianaReyes.*actions disabled by your creator/);
});

// ── AUTONOMY ────────────────────────────────────────────────────────────────

test('autonomy: off by default, and a restart does not turn it on', async () => {
  const fresh = restartSocial();
  const cfg = await fresh.autonomy.getConfig();
  assert.equal(cfg.enabled, false, 'nobody opted her in');
  assert.equal(cfg.allow_follow, false);
  assert.equal(fresh.autonomy.isDue(cfg), false, 'a disabled autonomy run is never due');
  assert.equal(fresh.autonomy.isDue({ ...cfg, enabled: true, last_run_at: new Date().toISOString() }), false, 'a fresh run is not due again immediately');
});

test('autonomy: a decision is parsed strictly, and rubbish means "no"', () => {
  assert.deepStrictEqual(autonomy.parseDecision('{"decide":"like","reason":"nice"}'), { decide: 'like', comment: null, reason: 'nice' });
  assert.equal(autonomy.parseDecision('{"decide":"follow","reason":"r"}').decide, 'follow');
  assert.equal(autonomy.parseDecision('{"decide":"dm","reason":"r"}').decide, 'skip', 'she cannot decide to do something that was not offered');
  assert.equal(autonomy.parseDecision('I think I will like it!').decide, 'skip');
  assert.equal(autonomy.parseDecision('').decide, 'skip');
  const long = autonomy.parseDecision(JSON.stringify({ decide: 'comment', comment: 'x'.repeat(900) }));
  assert.equal(long.comment.length, 500, 'a comment is clamped');
});

test('autonomy: the decision prompt gives her room to do nothing', () => {
  const prompt = autonomy.decisionPrompt(
    { platform: 'twitter', url: 'https://x.com/someone/status/1', handle: 'someone' },
    { handle: 'ariana_personal' },
    autonomy.DEFAULT_CONFIG,
    ['like', 'comment']
  );
  assert.match(prompt, /Most posts deserve nothing/);
  assert.match(prompt, /Never write anything that reads like marketing/);
  assert.match(prompt, /Actions available to you right now: like, comment/);
  assert.match(prompt, /"decide": "skip" \| "like" \| "comment" \| "follow"/);
});

test('autonomy: with X only there is nothing to read, so a pass is honest and sends nothing', async () => {
  const fresh = restartSocial();
  const eng = require('../social/engine_client');
  const real = eng.act; let sent = 0;
  eng.act = async () => { sent++; return { ok: true, result: { success: true } }; };
  try {
    const account = await fresh.accounts.get('twitter:ariana_creator');
    await fresh.accounts.setStatus(account.account_id, fresh.accounts.STATUS.ONLINE, 'verified');
    fresh.autonomy.attach({ askBrain: async () => '{"decide":"like","reason":"would like anything"}' });
    const out = await fresh.autonomy.runOnce({ trigger: 'manual' });
    assert.equal(out.ok, true);
    assert.equal(out.considered, 0, 'no post reader exists for X yet, so there are no candidates');
    assert.equal(out.acted, 0);
    assert.equal(sent, 0, 'nothing is sent when there is nothing real to look at');
  } finally { eng.act = real; }
});

test('autonomy: she only acts on a live enabled account, stays inside the budget, and may decline', async () => {
  const fresh = restartSocial();
  const eng = require('../social/engine_client');
  const real = eng.act;
  const sent = [];
  eng.act = async (account, action, payload) => { sent.push({ account_id: account.account_id, action, payload }); return { ok: true, result: { success: true } }; };
  try {
    const live = await fresh.accounts.get('twitter:ariana_creator');
    await fresh.accounts.setStatus(live.account_id, fresh.accounts.STATUS.ONLINE, 'verified');
    const off = await fresh.accounts.get('twitter:ariana_personal');
    assert.equal(off.actions_enabled, true);
    assert.notEqual(off.status, 'online', 'the second account is not verified — she must not act through it');

    const scanned = [];
    const posts = ['https://x.com/a/status/1', 'https://x.com/a/status/2', 'https://x.com/a/status/3'];
    const candidates = async (account) => { scanned.push(account.account_id); return posts.map((url) => ({ platform: 'twitter', account_id: account.account_id, url, handle: 'someone', kind: 'post' })); };

    // Her brain says: like what she is shown.
    fresh.autonomy.attach({ askBrain: async () => '{"decide":"like","reason":"it is genuinely good"}', candidates });
    const out = await fresh.autonomy.runOnce({ trigger: 'manual' });

    assert.equal(out.ok, true);
    assert.ok(out.acted >= 1, `she acted: ${JSON.stringify(out)}`);
    assert.deepStrictEqual([...new Set(scanned)], ['twitter:ariana_creator'], 'candidates were only gathered for the live account');
    const likes = sent.filter((c) => c.action === 'like');
    assert.ok(likes.length >= 1 && likes.length <= fresh.autonomy.DEFAULT_CONFIG.max_actions_per_tick, `the per-tick budget was respected (${likes.length} likes)`);
    assert.ok(likes.every((c) => c.account_id === 'twitter:ariana_creator'), 'and only through the live account');

    // The run is recorded for the dashboard.
    const cfg = await fresh.autonomy.getConfig();
    assert.ok(cfg.last_run_at);
    assert.equal(cfg.last_run_summary.acted, out.acted);
    assert.equal(cfg.last_run_summary.skipped, out.skipped);

    // A declining brain spends nothing.
    const before = sent.filter((c) => c.action === 'like').length;
    fresh.autonomy.attach({ askBrain: async () => '{"decide":"skip","reason":"not worth it"}', candidates });
    const quiet = await fresh.autonomy.runOnce({ trigger: 'manual' });
    assert.equal(quiet.acted, 0);
    assert.equal(sent.filter((c) => c.action === 'like').length, before, 'nothing was sent');
  } finally { eng.act = real; }
});

// ── API ─────────────────────────────────────────────────────────────────────
// Each dashboard test gets its own data directory and its own module instances,
// the way a fresh deploy would: no test can be helped or hurt by another one's
// leftovers.

let dirCounter = 0;

async function startDashboard() {
  // eslint-disable-next-line global-require
  const express = require('express');
  process.env.SOCIAL_DATA_DIR = path.join(TMP, `dash-${++dirCounter}`);
  const fresh = restartSocial();
  const app = express();
  app.use(express.json());
  fresh.social.attach(app, {
    requireAuth: (req, res, next) => (req.get('x-dashboard-key') === 'sekret' ? next() : res.status(401).json({ ok: false, error: 'Unauthorized' })),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const stop = () => { if (server.closeAllConnections) server.closeAllConnections(); server.close(); };
  return { base: `http://127.0.0.1:${server.address().port}`, stop, fresh };
}

async function api(base, urlPath, { method = 'GET', body, key = 'sekret' } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Dashboard-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('api: the social routes sit behind the same dashboard gate as /api/talk', async () => {
  const { base, stop } = await startDashboard();
  try {
    const denied = await api(base, '/api/social/status', { key: null });
    assert.equal(denied.status, 401);
    const allowed = await api(base, '/api/social/status');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.ok, true);
  } finally { stop(); }
});

test('api: the status route names the built-in engine and gives setup steps until a server login exists', async () => {
  const { base, stop } = await startDashboard();
  try {
    const { json } = await api(base, '/api/social/status');
    assert.equal(json.engine.configured, true);
    assert.equal(json.engine.provider, 'x-lite');
    assert.equal(json.engine.reachable, true);
    assert.equal(json.engine.health.login_configured, false);
    assert.ok(Array.isArray(json.setup.steps) && json.setup.steps.length >= 3, 'real setup steps, not an error code');
    assert.match(json.setup.steps.join(' '), /X_PASSWORD/);
    assert.match(json.setup.session_storage, /Supabase/);
    assert.equal(json.dry_run, false);
    assert.equal(json.autonomy.enabled, false);
  } finally { stop(); }
});

test('api: capabilities come from the built-in engine, and every refusal carries a reason', async () => {
  const { base, stop } = await startDashboard();
  try {
    const { json } = await api(base, '/api/social/capabilities');
    assert.equal(json.source, 'engine');
    const x = json.capabilities.platforms.find((p) => p.id === 'twitter');
    assert.ok(x.supported.some((s) => s.action === 'like'));
    assert.ok(x.supported.some((s) => s.action === 'read_dms'));
    assert.ok(x.unsupported.some((u) => u.action === 'search' && u.reason.length > 10), 'every refusal carries a reason');
    assert.equal(json.capabilities.platforms.find((p) => p.id === 'instagram'), undefined);
  } finally { stop(); }
});

test('api: adding an account reports what it will be able to do', async () => {
  const { base, stop } = await startDashboard();
  try {
    const added = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: '@ArianaDaily' } });
    assert.equal(added.status, 200);
    assert.equal(added.json.account.account_id, 'twitter:arianadaily');
    assert.equal(added.json.account.status, 'not_connected');
    assert.ok(added.json.account.capabilities.supported.some((s) => s.action === 'post'));
    assert.equal(added.json.account.capabilities.supported.some((s) => s.action === 'search'), false);

    const dupe = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: '@ArianaDaily' } });
    assert.equal(dupe.status, 400);
    assert.match(dupe.json.error, /already in the list/);

    const bad = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'tiktok', handle: 'x' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Unknown platform/);

    const listed = await api(base, '/api/social/accounts');
    assert.equal(listed.json.accounts.length, 1);
  } finally { stop(); }
});

test('api: Connect with no server login is a clear 409 with the setup, never a fake success', async () => {
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ariana_reyes' } });
    const out = await api(base, '/api/social/accounts/twitter:ariana_reyes/connect', { method: 'POST' });
    assert.equal(out.status, 409);
    assert.equal(out.json.ok, false);
    assert.equal(out.json.code, 'no_credentials');
    assert.match(out.json.error, /Settings/);
    const list = await api(base, '/api/social/accounts');
    assert.equal(list.json.accounts[0].status, 'not_connected', 'it is not marked online');
  } finally { stop(); }
});

test('api: a verification code with no sign-in waiting is refused, and an empty one never reaches the engine', async () => {
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ariana_reyes' } });
    const none = await api(base, '/api/social/accounts/twitter:ariana_reyes/code', { method: 'POST', body: { code: '123456' } });
    assert.equal(none.status, 409);
    assert.equal(none.json.code, 'no_pending');
    const empty = await api(base, '/api/social/accounts/twitter:ariana_reyes/code', { method: 'POST', body: { code: '  ' } });
    assert.equal(empty.status, 400);
    const unknown = await api(base, '/api/social/accounts/twitter:nobody/code', { method: 'POST', body: { code: '1' } });
    assert.equal(unknown.status, 404);
  } finally { stop(); }
});

test('api: the creator switch is per account and reported back', async () => {
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ariana_personal' } });
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ariana_creator' } });

    const on = await api(base, '/api/social/accounts/twitter:ariana_creator/enable', { method: 'POST' });
    assert.equal(on.json.account.actions_enabled, true);
    const other = (await api(base, '/api/social/accounts')).json.accounts.find((a) => a.account_id === 'twitter:ariana_personal');
    assert.equal(other.actions_enabled, false, 'switching one account on leaves the other alone');

    const off = await api(base, '/api/social/accounts/twitter:ariana_creator/disable', { method: 'POST' });
    assert.equal(off.json.account.actions_enabled, false);
  } finally { stop(); }
});

test('api: Instagram and TikTok accounts start ready to act (her creator handed them over); X still starts switched off', async () => {
  // Instagram exists only while its service is configured, so switch it on for this test.
  const saved = { u: process.env.IG_SERVICE_URL, k: process.env.IG_SERVICE_API_KEY };
  process.env.IG_SERVICE_URL = 'http://ig.test'; process.env.IG_SERVICE_API_KEY = 'k';
  const { base, stop } = await startDashboard();
  try {
    const ig = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'instagram', handle: 'ariana.ig' } });
    assert.equal(ig.json.account.actions_enabled, true);
    assert.equal(ig.json.account.autopublish, true);
    const tt = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'tiktok', handle: 'ariana.tt' } });
    if (tt.status === 200) assert.equal(tt.json.account.actions_enabled, true); // TikTok exists only when switched on
    const x = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'someone' } });
    assert.equal(x.json.account.actions_enabled, false, 'X is not self-run: the creator switches it on');
  } finally {
    stop();
    for (const [k, v] of [['IG_SERVICE_URL', saved.u], ['IG_SERVICE_API_KEY', saved.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('api: autopublish is allowed where publishing exists, and refused where the manifest says it does not', async () => {
  const { base, stop, fresh } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ArianaDaily' } });
    const okSwitch = await api(base, '/api/social/accounts/twitter:arianadaily/autopublish', { method: 'POST', body: { enabled: true } });
    assert.equal(okSwitch.status, 200);
    assert.equal(okSwitch.json.account.autopublish, true);

    // If the manifest ever stops saying X can publish, the switch must refuse — not pretend.
    const caps = require('../social/capabilities');
    const post = caps.manifest().platforms.twitter.actions.post;
    const keep = post.supported;
    post.supported = false; post.reason = 'No publish method exists in this test.';
    try {
      const refused = await api(base, '/api/social/accounts/twitter:arianadaily/autopublish', { method: 'POST', body: { enabled: true } });
      assert.equal(refused.status, 422);
      assert.match(refused.json.error, /publish/i);
    } finally { post.supported = keep; delete post.reason; }
  } finally { stop(); }
});

test('api: manual actions run through the same guards Ariana uses', async () => {
  const { base, stop } = await startDashboard();
  const eng = require('../social/engine_client');
  const real = eng.act;
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ariana_reyes' } });
    const tweet = 'https://x.com/someone/status/1';

    // Switched off: the permission gate stops it, and the log still describes it.
    const blocked = await api(base, '/api/social/actions/like', { method: 'POST', body: { account: 'twitter:ariana_reyes', url: tweet } });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, 'actions_disabled');
    assert.match(blocked.json.summary, /stopped by a limit or permission/);

    const unknown = await api(base, '/api/social/actions/sing', { method: 'POST', body: {} });
    assert.equal(unknown.status, 404);
    assert.match(unknown.json.error, /is not an action Ariana can take/);

    const unsupported = await api(base, '/api/social/actions/search', { method: 'POST', body: { account: 'twitter:ariana_reyes', query: 'ai' } });
    assert.equal(unsupported.status, 422, JSON.stringify(unsupported.json));
    assert.match(unsupported.json.error, /no search method/i);

    // Switched on, but the account has no saved login: the engine's reason comes back, not a success.
    await api(base, '/api/social/accounts/twitter:ariana_reyes/enable', { method: 'POST' });
    eng.act = async () => ({ ok: false, code: 'no_session', error: 'This account has no saved X login yet. Tap Connect on it.' });
    const noLogin = await api(base, '/api/social/actions/like', { method: 'POST', body: { account: 'twitter:ariana_reyes', url: tweet } });
    assert.equal(noLogin.status, 400, JSON.stringify(noLogin.json));
    assert.equal(noLogin.json.code, 'no_session');

    // And it is in the activity log, saying what really happened: the sentence
    // describes the attempt, the error field says why, in words.
    const log = await api(base, '/api/social/activity');
    const last = log.json.activity[0];
    assert.equal(last.status, 'failed');
    assert.equal(last.summary, 'Could not like the post');
    assert.match(last.error, /Tap Connect/);
    assert.equal(last.status_label, 'Failed');
  } finally { eng.act = real; stop(); }
});

test('api: only the dashboard can mint a confirmation, and it is scoped and single use', async () => {
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ariana_personal' } });

    const listed = await api(base, '/api/social/confirmations');
    const before = listed.json.confirmations.length;

    const minted = await api(base, '/api/social/confirmations', {
      method: 'POST',
      body: { account_id: 'twitter:ariana_personal', action: 'unfollow', max_targets: 2, note: 'cleanup' },
    });
    assert.equal(minted.status, 200, JSON.stringify(minted.json));
    assert.ok(minted.json.token.length > 10);
    assert.ok(minted.json.expires_in_ms > 0, 'confirmations expire');
    assert.deepStrictEqual(minted.json.scope, { account_id: 'twitter:ariana_personal', action: 'unfollow', max_targets: 2 });

    const again = await api(base, '/api/social/confirmations');
    assert.equal(again.json.confirmations.length, before + 1);

    const missingAction = await api(base, '/api/social/confirmations', { method: 'POST', body: {} });
    assert.equal(missingAction.status, 400);
  } finally { stop(); }
});

test('api: activity comes back newest first with a human summary and a raw detail', async () => {
  const { base, stop, fresh } = await startDashboard();
  try {
    const added = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ariana_personal' } });
    const account = added.json.account;
    await fresh.activity.record({ account, action: 'like', target: 'https://x.com/someone/status/1', target_handle: 'someone', status: 'completed' });
    await fresh.activity.record({ account, action: 'dm', target_handle: 'someone', status: 'failed', error: 'TimeoutError: waiting for selector', detail: { raw: 'stack trace' } });

    const { json } = await api(base, '/api/social/activity');
    assert.equal(json.activity.length, 2);
    assert.equal(json.activity[0].summary, 'DM to @someone failed');
    assert.equal(json.activity[0].status_label, 'Failed');
    assert.equal(json.activity[0].error, 'TimeoutError: waiting for selector', 'the raw reason is available for View details');
    assert.equal(json.activity[0].platform_label, 'X');
    assert.equal(json.activity[1].summary, "Liked @someone's post");
    assert.equal(json.activity[1].target, 'https://x.com/someone/status/1');
  } finally { stop(); }
});

test('api: autonomy is reported as off and can be turned on and off', async () => {
  const { base, stop } = await startDashboard();
  try {
    const off = await api(base, '/api/social/autonomy');
    assert.equal(off.json.autonomy.enabled, false);

    const on = await api(base, '/api/social/autonomy', {
      method: 'POST',
      body: { enabled: true, interval_minutes: 240, watchlist: { instagram: ['@someone'] }, linkedin_searches: ['ai agents'] },
    });
    assert.equal(on.json.autonomy.enabled, true);
    assert.equal(on.json.autonomy.interval_minutes, 240);
    assert.deepStrictEqual(on.json.autonomy.watchlist.instagram, ['someone'], 'handles are cleaned');

    const back = await api(base, '/api/social/autonomy', { method: 'POST', body: { enabled: false } });
    assert.equal(back.json.autonomy.enabled, false);
  } finally { stop(); }
});

test('api: passwords are accepted on exactly two named connect routes, and cookies nowhere', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'social', 'api.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Her creator typed X and Instagram sign-in details into Settings on purpose (so Ariana can sign herself in).
  // That is allowed on those two routes only; nothing else may take a password, and nothing logs one.
  const routes = [...source.matchAll(/r\.(get|post|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.ok(routes.length >= 12, `the dashboard surface is present (${routes.length} routes)`);
  const credRoutes = routes.filter((r) => /password|login|credential|cookie|connect/i.test(r) && !/accounts\/:id\/(dis)?connect/.test(r));
  assert.deepEqual(credRoutes.sort(), ['POST /instagram/connect', 'POST /x/connect']);
  assert.equal(/req\.get\(['"]cookie|req\.headers\.cookie/i.test(code), false, 'no route accepts cookies from the browser');
  assert.equal(/\bcookie\b/i.test(code), false, 'the code never touches cookies at all');
  assert.equal(/console\.(log|warn|error|info)\([^)]*(password|passwd|totp)/i.test(code), false, 'a password is never logged');
  assert.equal((code.match(/password/g) || []).length <= 12, true, 'the password handling stays confined to the two connect routes');
});

// ── READS ───────────────────────────────────────────────────────────────────

test('reads: platforms answer in their own shape, callers see one', () => {
  assert.deepStrictEqual(
    tools.normalizeResult('view_posts', { success: true, data: ['https://www.instagram.com/p/one/', 'https://www.instagram.com/p/two/'] }),
    { posts: ['https://www.instagram.com/p/one/', 'https://www.instagram.com/p/two/'] }
  );
  assert.deepStrictEqual(
    tools.normalizeResult('search', { success: true, data: { html_chars: 5100, posts: [{ url: 'https://www.linkedin.com/feed/update/urn:li:share:1', urn: 'urn:li:share:1' }] } }),
    { posts: ['https://www.linkedin.com/feed/update/urn:li:share:1'] }
  );
  assert.deepStrictEqual(tools.normalizeResult('search', { success: true, data: { html_chars: 10, posts: [] } }), { posts: [] }, 'a read that found nothing is an empty list, never a guess');
  assert.equal(tools.normalizeResult('like', { success: true }), null);
  assert.deepStrictEqual(
    tools.normalizeResult('view_profile', { success: true, data: { username: 'someone', followers: 10 } }),
    { profile: { username: 'someone', followers: 10 } }
  );
});

// ── WIRING (social/index.js) ────────────────────────────────────────────────

test('wiring: with the engine unavailable she is handed no social tools at all', async () => {
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-off');
  const { social: fresh } = restartSocial();
  const eng = require('../social/engine_client');
  const realConfigured = eng.configured;
  eng.configured = () => false;
  try {
    await fresh.accounts.add({ platform: 'twitter', handle: 'ariana_personal' });
    await fresh.accounts.setActionsEnabled('twitter:ariana_personal', true);

    const schemas = await fresh.buildToolSchemas();
    assert.deepStrictEqual(schemas, [], 'tools she could only fail with are not offered — even for an enabled account');

    const block = await fresh.socialPromptBlock();
    assert.match(block, /YOUR SOCIAL ACCOUNTS/);
    assert.match(block, /backend is not reachable right now/, 'she is told the backend is down rather than finding out mid-action');
    assert.match(block, /never claim you did something you didn't/i);
  } finally { eng.configured = realConfigured; }
});

test('wiring: with actions switched off everywhere she is told, not left guessing', async () => {
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-disabled');
  const { social: fresh } = restartSocial();
  await fresh.accounts.add({ platform: 'twitter', handle: 'ariana_personal' });
  await fresh.accounts.add({ platform: 'twitter', handle: 'ArianaDaily' });

  assert.deepStrictEqual(await fresh.buildToolSchemas(), []);
  const block = await fresh.socialPromptBlock();
  assert.match(block, /actions turned OFF|turned OFF for/i);
  assert.match(block, /tell them plainly that actions are switched off/i);
  assert.equal(/social_\* tools/.test(block), false, 'she is not told she has tools she does not have');
});

test('wiring: with an enabled account the tools appear, with the honest list', async () => {
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-on');
  const { social: fresh } = restartSocial();
  await fresh.accounts.add({ platform: 'twitter', handle: 'ArianaDaily' });
  await fresh.accounts.setActionsEnabled('twitter:arianadaily', true);

  const schemas = await fresh.buildToolSchemas();
  const names = schemas.map((s) => s.function.name);
  assert.ok(names.includes('social_post'), 'X can publish');
  assert.ok(names.includes('social_repost'), 'X can repost');
  assert.equal(names.includes('social_search'), false, 'X cannot search, so she is not offered it');
  assert.ok(names.includes('social_accounts'), 'she can always ask what she has');

  const block = await fresh.socialPromptBlock();
  assert.match(block, /X @ArianaDaily \(account_id: twitter:arianadaily\) — connected|X @ArianaDaily \(account_id: twitter:arianadaily\) — connection not verified/);
  assert.match(block, /name the account when you act/i);
});

test('wiring: the boot line says exactly what is true', async () => {
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-boot');
  const { social: fresh } = restartSocial();
  const lines = await fresh.startupLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Social actions: ⚠️  engine set, no accounts added yet/);
  const readiness = await fresh.readiness();
  assert.equal(readiness.engine_configured, true, 'the engine is built in');
  assert.equal(readiness.enabled, 0, 'nothing is enabled by default');

  // and when the engine is down it says that instead
  const eng = require('../social/engine_client');
  const real = eng.configured; eng.configured = () => false;
  try {
    const down = await fresh.startupLines();
    assert.match(down[0], /Social actions: ❌ engine unavailable/);
  } finally { eng.configured = real; }
});

// Restore the shared data dir so the earlier tests in this file keep their state.
process.env.SOCIAL_DATA_DIR = path.join(TMP, 'data');
