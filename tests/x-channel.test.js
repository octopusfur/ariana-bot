// tests/x-channel.test.js
// ─────────────────────────────────────────────────────────────────────────────
// X as a chat channel through Ariana's built-in X engine (x_channel.js). What these pin:
//
//   · NOTHING RUNS ON ITS OWN. No timer unless X_INBOX_POLL_MINUTES is set; the
//     status calls never touch the engine.
//   · THE INBOX IS A REAL ONE. First look answers nothing from old history; she
//     never replies to her own last message, or to one she can't attribute; each
//     message is answered at most once, even if something fails midway.
//   · REPLIES GO THROUGH THE GUARDS she already has (creator switch, daily
//     ceiling, dry run, activity log) — the channel adds no way around them.
//   · EVERY PLACE index.js routes by platform knows about X, so an X contact can
//     never fall through to SMS.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-x-channel-'));
process.env.SOCIAL_DATA_DIR = TMP;
delete process.env.SUPABASE_URL;
delete process.env.SOCIAL_DRY_RUN;
delete process.env.X_INBOX_POLL_MINUTES;

const accounts = require('../social/accounts');
const activity = require('../social/activity');
const xc = require('../x_channel');
const engine = require('../social/engine_client');

// The engine is stubbed at the engine_client seam (x-engine.test.js covers the adapter itself).
const real = { act: engine.act };
let calls = [];
let inbox = []; // what the engine's read_dms returns
let readStatus = 200;
let readJson = null;
let dmStatus = 200;

function fakeEngine() {
  calls = [];
  engine.act = async (account, action, payload) => {
    calls.push({ action, body: { payload, platform: account.platform } });
    await new Promise((r) => setImmediate(r)); // a real await, so overlapping checks can overlap
    if (action === 'read_dms') {
      if (readStatus !== 200) return { ok: false, code: (readJson && readJson.code) || 'action_failed', error: (readJson && readJson.error) || 'engine said no' };
      return readJson || { ok: true, result: { success: true, items: inbox } };
    }
    if (action === 'dm') return dmStatus === 200 ? { ok: true, result: { success: true } } : { ok: false, code: 'action_failed', error: 'engine said no' };
    return { ok: true, result: { success: true } };
  };
}

const theirs = (from, text) => ({ from, last_message: text, last_from_me: false });
const mine = (from, text) => ({ from, last_message: text, last_from_me: true });

let accountId;
async function reset({ enabled = true } = {}) {
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) { try { fs.rmSync(path.join(TMP, f)); } catch (_) {} }
  accounts.invalidate();
  const r = await accounts.add({ platform: 'twitter', handle: 'ariana_x' });
  accountId = r.account.account_id;
  if (enabled) await accounts.setActionsEnabled(accountId, true);
  inbox = []; readStatus = 200; readJson = null; dmStatus = 200;
  delete process.env.X_INBOX_MAX_PER_CHECK;
  delete process.env.X_CHANNEL_MAX_REPLIES_PER_DAY;
  delete process.env.SOCIAL_MAX_READ_DMS;
  delete process.env.SOCIAL_DRY_RUN;
  fakeEngine();
}

test.after(() => { engine.act = real.act; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const collect = () => { const got = []; return { got, onMessage: async (m) => { got.push(m); } }; };

// ── PARSING ─────────────────────────────────────────────────────────────────

test('ids and handles', () => {
  assert.equal(xc.isXId('x_bob'), true);
  assert.equal(xc.isXId('tg_123'), false);
  assert.equal(xc.isXId('2348012345678'), false);
  assert.equal(xc.handleFromId('x_bob'), 'bob');
  assert.equal(xc.normHandle('@Bob_1'), 'Bob_1');
  assert.equal(xc.normHandle('a/b'), null);
  assert.equal(xc.normHandle('x'.repeat(16)), null);
});

test('readItems: only an explicit "not from me" counts as theirs; junk is dropped', () => {
  const items = xc.readItems([
    theirs('@bob', ' hello '),
    mine('amy', 'sent by her'),
    { from: 'carl', last_message: 'no direction reported' },
    { from: 'dan', last_message: 'string flag', last_from_me: 'false' },
    { from: 'bad handle!', last_message: 'x', last_from_me: false },
    { from: 'eve', last_message: '   ', last_from_me: false },
    null, 'nope', 42,
  ]);
  assert.deepStrictEqual(items.map((i) => [i.from, i.theirs]), [['bob', true], ['amy', false], ['carl', false], ['dan', false]]);
  assert.equal(items[0].text, 'hello');
  assert.deepStrictEqual(xc.readItems(undefined), []);
});

// ── NOTHING RUNS ON ITS OWN ─────────────────────────────────────────────────

test('no timer: status never touches the engine, and init starts nothing by default', async () => {
  await reset();
  const s = await xc.status();
  assert.equal(calls.length, 0, 'status must not call the engine');
  assert.equal(s.polling_minutes, 0);
  assert.equal(s.configured, true);
  assert.equal(s.engine, 'x-lite');

  const realSet = global.setInterval; let timers = 0;
  global.setInterval = (...a) => { timers++; return realSet(...a); };
  try {
    const routes = {};
    const app = { get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; }, post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; } };
    const ctl = xc.init({ app, requireAuth: (_q, _r, n) => n(), onMessage: async () => {} });
    assert.equal(timers, 0, 'no setInterval unless X_INBOX_POLL_MINUTES is set');
    assert.deepStrictEqual(Object.keys(routes).sort(), ['GET /api/x/status', 'POST /api/x/check']);
    ctl.stop();

    process.env.X_INBOX_POLL_MINUTES = '30';
    const ctl2 = xc.init({ app, requireAuth: (_q, _r, n) => n(), onMessage: async () => {} });
    assert.equal(timers, 1, 'opting in starts exactly one timer');
    ctl2.stop();
  } finally { global.setInterval = realSet; delete process.env.X_INBOX_POLL_MINUTES; }
});

test('source: the only setInterval in x_channel.js is the opt-in one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'x_channel.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((src.match(/setInterval\s*\(/g) || []).length, 1);
  assert.ok(/if \(minutes > 0\)/.test(src));
});

test('status: the built-in engine can receive (it reads the inbox over plain HTTP), and status stays offline', async () => {
  await reset();
  const s = await xc.status();
  assert.equal(s.engine, 'x-lite');
  assert.equal(s.can_receive, true);
  assert.equal(s.note, null);
  assert.equal(calls.length, 0, 'status must not call the engine');
});

// ── THE INBOX ───────────────────────────────────────────────────────────────

test('first check only learns: old history is never answered', async () => {
  await reset();
  inbox = [theirs('bob', 'hey from last week'), theirs('amy', 'ping')];
  const { got, onMessage } = collect();
  const { summary, done } = await xc.checkInbox(onMessage);
  await done;
  assert.equal(summary.ok, true);
  assert.equal(summary.baseline, true);
  assert.equal(summary.conversations, 2);
  assert.equal(got.length, 0);
});

test('after the first look, a new message from someone is handed to the brain like any chat', async () => {
  await reset();
  inbox = [theirs('bob', 'old')];
  await (await xc.checkInbox(async () => {})).done;
  inbox = [theirs('bob', 'old'), theirs('amy', 'hi ariana!')];
  const { got, onMessage } = collect();
  const { summary, done } = await xc.checkInbox(onMessage);
  await done;
  assert.equal(summary.baseline, false);
  assert.equal(summary.answering, 1);
  assert.deepStrictEqual(got, [{ id: 'x_amy', platform: 'x', from: 'amy', text: 'hi ariana!', chatId: 'amy', phoneNumberId: null, name: '@amy' }]);
});

test('each message is answered once; a different message from the same person is answered', async () => {
  await reset();
  inbox = [];
  await (await xc.checkInbox(async () => {})).done;
  const { got, onMessage } = collect();
  inbox = [theirs('amy', 'first')];
  await (await xc.checkInbox(onMessage)).done;
  await (await xc.checkInbox(onMessage)).done; // same inbox again
  assert.equal(got.length, 1, 'the same message must not be answered twice');
  inbox = [theirs('amy', 'second')];
  await (await xc.checkInbox(onMessage)).done;
  assert.deepStrictEqual(got.map((m) => m.text), ['first', 'second']);
});

test('never answers when the last message was hers, or when the engine cannot say', async () => {
  await reset();
  await (await xc.checkInbox(async () => {})).done;
  inbox = [mine('amy', 'she wrote last'), { from: 'bob', last_message: 'direction unknown' }];
  const { got, onMessage } = collect();
  const { summary, done } = await xc.checkInbox(onMessage);
  await done;
  assert.equal(summary.answering, 0);
  assert.equal(got.length, 0);
});

test('a limit per check; the rest wait for the next one', async () => {
  await reset();
  await (await xc.checkInbox(async () => {})).done;
  process.env.X_INBOX_MAX_PER_CHECK = '5';
  inbox = Array.from({ length: 7 }, (_, i) => theirs('user' + i, 'msg ' + i));
  const { got, onMessage } = collect();
  const first = await xc.checkInbox(onMessage); await first.done;
  assert.equal(first.summary.answering, 5);
  assert.equal(first.summary.waiting, 2);
  const second = await xc.checkInbox(onMessage); await second.done;
  assert.equal(second.summary.answering, 2);
  assert.equal(new Set(got.map((m) => m.from)).size, 7, 'all seven, none twice');
});

test('marked answered BEFORE she replies: a failure midway never causes a second reply', async () => {
  await reset();
  await (await xc.checkInbox(async () => {})).done;
  inbox = [theirs('amy', 'will crash the brain')];
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    await (await xc.checkInbox(async () => { throw new Error('brain exploded'); })).done;
  } finally { console.error = realErr; }
  assert.ok(errs.some((e) => /brain exploded/.test(e)), 'the failure is logged, not swallowed');
  const { got, onMessage } = collect();
  await (await xc.checkInbox(onMessage)).done;
  assert.equal(got.length, 0, 'it is not retried and not answered twice');
});

test('overlapping checks: the second is refused, not run in parallel', async () => {
  await reset();
  const [a, b] = await Promise.all([xc.readInbox(), xc.readInbox()]);
  const codes = [a.summary.code, b.summary.code];
  assert.ok(codes.includes('busy'), 'one of them must be told it is busy');
});

test('a read that fails changes nothing and says why', async () => {
  await reset();
  readStatus = 502; readJson = { success: false, code: 'session_expired', error: 'The session is no longer logged in.' };
  const { summary, fresh } = await xc.readInbox();
  assert.equal(summary.ok, false);
  assert.equal(summary.code, 'session_expired');
  assert.deepStrictEqual(fresh, []);
  // …and it was not mistaken for "the first look" — a later good read still only learns
  readStatus = 200; readJson = null; inbox = [theirs('bob', 'old')];
  const again = await xc.readInbox();
  assert.equal(again.summary.baseline, true);
});

test('an engine with no inbox reader is told so in plain words', async () => {
  await reset();
  readStatus = 502; readJson = { success: false, code: 'unsupported', error: 'read_dms is not supported' };
  const { summary } = await xc.readInbox();
  assert.equal(summary.ok, false);
  assert.match(summary.error, /could not read the inbox/);
});

test('it refuses cleanly when there is nothing to act as', async () => {
  await reset({ enabled: false });
  let r = await xc.readInbox();
  assert.equal(r.summary.code, 'actions_disabled');
  for (const f of ['accounts.json']) { try { fs.rmSync(path.join(TMP, f)); } catch (_) {} }
  accounts.invalidate();
  fakeEngine();
  r = await xc.readInbox();
  assert.equal(r.summary.code, 'no_account');
  assert.equal(calls.length, 0, 'nothing was sent to the engine');
});

test('guards on reading: dry run reads nothing; a daily ceiling stops further reads; every read is logged', async () => {
  await reset();
  process.env.SOCIAL_DRY_RUN = '1';
  assert.equal((await xc.readInbox()).summary.code, 'dry_run');
  assert.equal(calls.length, 0);
  delete process.env.SOCIAL_DRY_RUN;

  process.env.SOCIAL_MAX_READ_DMS = '1';
  assert.equal((await xc.readInbox()).summary.ok, true);
  const second = await xc.readInbox();
  assert.equal(second.summary.code, 'daily_limit');
  assert.equal(calls.filter((c) => c.action === 'read_dms').length, 1);
  const log = await activity.recent(10);
  assert.ok(log.some((e) => e.action === 'read_dms' && e.status === 'completed' && e.actor === 'x-channel'));
});

// ── REPLYING ────────────────────────────────────────────────────────────────

test('a reply goes out as a normal social DM, through the guards, and is logged', async () => {
  await reset();
  await xc.sendText('x_amy', 'hey you');
  const dm = calls.find((c) => c.action === 'dm');
  assert.deepStrictEqual(dm.body.payload, { username: 'amy', message: 'hey you' });
  assert.equal(dm.body.platform, 'twitter');
  const log = await activity.recent(5);
  assert.ok(log.some((e) => e.action === 'dm' && e.status === 'completed' && e.target_handle === 'amy'));
});

test('replies obey the creator switch, the daily ceiling, dry run, and bad handles', async () => {
  await reset({ enabled: false });
  await assert.rejects(() => xc.sendText('x_amy', 'hi'), /Actions are off/);
  assert.equal(calls.length, 0);

  await reset();
  await assert.rejects(() => xc.sendText('x_not a handle', 'hi'), /not a valid handle/);
  assert.equal(calls.length, 0);

  process.env.X_CHANNEL_MAX_REPLIES_PER_DAY = '2';
  await xc.sendText('x_amy', 'one');
  await xc.sendText('x_amy', 'two');
  await assert.rejects(() => xc.sendText('x_amy', 'three'), /Daily limit/);
  assert.equal(calls.filter((c) => c.action === 'dm').length, 2);

  await reset();
  process.env.SOCIAL_DRY_RUN = '1';
  await assert.rejects(() => xc.sendText('x_amy', 'hi'), /Dry run/);
  assert.equal(calls.length, 0);
});

test('an engine failure on a reply is surfaced, not swallowed', async () => {
  await reset();
  dmStatus = 502;
  await assert.rejects(() => xc.sendText('x_amy', 'hi'), /engine said no/);
});

test('pictures: X messages here carry text only — the caption goes, an empty one sends nothing', async () => {
  await reset();
  await xc.sendImage('x_amy', 'https://img.test/a.jpg', 'look at this');
  assert.deepStrictEqual(calls.filter((c) => c.action === 'dm').map((c) => c.body.payload.message), ['look at this']);
  calls.length = 0;
  await xc.sendImage('x_amy', 'https://img.test/a.jpg', '');
  assert.equal(calls.length, 0);
});

// ── THE ROUTES ──────────────────────────────────────────────────────────────

test('POST /api/x/check answers with the summary; replies continue in the background', async () => {
  await reset();
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; }, post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; } };
  const got = [];
  xc.init({ app, requireAuth: (_q, _r, n) => n(), onMessage: async (m) => { got.push(m); } });
  const call = async (key) => {
    let out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    await routes[key]({}, res);
    return out;
  };
  inbox = [theirs('bob', 'old')];
  assert.equal((await call('POST /api/x/check')).body.baseline, true);
  inbox = [theirs('bob', 'old'), theirs('amy', 'hello')];
  const second = await call('POST /api/x/check');
  assert.equal(second.status, 200);
  assert.equal(second.body.answering, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 1);

  readStatus = 502; readJson = { success: false, code: 'session_expired', error: 'logged out' };
  const failed = await call('POST /api/x/check');
  assert.equal(failed.status, 409);
  assert.equal(failed.body.ok, false);
  const st = await call('GET /api/x/status');
  assert.equal(st.body.account.handle, 'ariana_x');
  assert.equal(st.body.last_check.ok, false);
});

// ── EVERY ROUTING SITE KNOWS ABOUT X ────────────────────────────────────────

test('index.js: every place that routes by platform knows about X (an X contact can never fall through to SMS)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.equal((src.match(/\(tg_\|sg_\|sms_\|fb_\|sc_\)/g) || []).length, 0, 'a prefix list without x_ would leave "x_name" un-stripped');
  assert.equal((src.match(/\(tg_\|sg_\|sms_\|fb_\|sc_\|x_\)/g) || []).length, 0, 'a prefix list without ig_/tt_ would leave "ig_name" un-stripped');
  assert.ok((src.match(/\(tg_\|sg_\|sms_\|fb_\|sc_\|x_\|ig_\|tt_\)/g) || []).length >= 15);

  const snap = (src.match(/snapchat\.send(Text|Image)\(/g) || []).length;
  const x = (src.match(/xchannel\.send(Text|Image)\(/g) || []).length;
  assert.equal(x, snap, `Snapchat is sent to in ${snap} places but X in ${x}`);

  // id → platform chains
  assert.equal((src.match(/startsWith\(\\?["']sc_\\?["']\)\s+\? \\?["']snapchat\\?["']/g) || []).length,
               (src.match(/startsWith\(\\?["']x_\\?["']\)\s+\? \\?["']x\\?["']/g) || []).length, 'id→platform chains');

  assert.ok(/X_PROACTIVE !== 'on'\) continue/.test(src), 'she must not message first on X unless opted in');
  assert.ok(/xchannel\.init\(/.test(src));
});

test('dashboard: every list of channels includes X, with the supplied logo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.equal((html.match(/\['wa','tg','sig','snap','sms','fb'\]/g) || []).length, 0, 'a channel list is missing x');
  assert.equal((html.match(/\['wa','tg','sig','snap','sms','fb','x'\]/g) || []).length, 2);
  assert.equal((html.match(/\['wa','tg','sig','snap','sms','fb','x','ig','tt'\]/g) || []).length, 1, 'the badge list carries Instagram and TikTok too');
  assert.ok(/openChannel\('x'\)/.test(html), 'home tile');
  assert.ok(/id="ch-x"/.test(html) && /xCheck\(\)/.test(html), 'settings card');
  assert.ok(/p==='x'\)return'<svg/.test(html), 'chat list icon');
  // the exact path from the supplied logo is used in every place
  const logo = 'M714.163 519.284 1160.89 0h-105.86L667.137 450.887';
  assert.equal(html.split(logo).length - 1, 3, 'tile, settings card and chat icon all use the X logo');
});
