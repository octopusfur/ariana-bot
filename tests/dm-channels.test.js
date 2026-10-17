// tests/dm-channels.test.js — Instagram/TikTok DMs as conversations.
// Pins down: first run is history only; new inbound reaches the brain once; old messages are never
// answered; people who wrote are recorded (that record IS the "never DM first" rule); replies go out
// as replies; TikTok polling is off unless asked for.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

process.env.SOCIAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-dm-'));
delete process.env.SUPABASE_URL;
delete process.env.SOCIAL_ENGINE_URL;
delete process.env.X_SERVICE_URL;
process.env.BROWSER_USE_API_KEY = 'bu_test';
process.env.IG_SERVICE_URL = 'http://ig.invalid';
process.env.IG_SERVICE_API_KEY = 'k'.repeat(32);

const engine = require('../social/engine_client');
const accounts = require('../social/accounts');
const inbound = require('../social/dm_inbound');
const dm = require('../social/dm_channels');

const ig = { account_id: 'instagram:ariana.test', platform: 'instagram', handle: 'ariana.test', actions_enabled: true };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

let threads = [];
let sent = [];
engine.ig.inbox = async () => ({ ok: true, threads });
const realAct = engine.act;
engine.act = async (account, action, payload, opts) => {
  if (action === 'dm') { sent.push({ account, payload, opts }); return { ok: true, result: { success: true } }; }
  return realAct(account, action, payload, opts);
};
accounts.list = async () => [ig];

const thread = (username, msgs) => ({ thread_id: 't_' + username, username, user_id: '1', request: false, messages: msgs });

test('first run remembers history and answers none of it, but records who wrote', async () => {
  threads = [thread('old.friend', [{ id: 'm2', text: 'you there?', from_them: true, at: iso(3600e3) }, { id: 'm1', text: 'hey', from_them: false, at: iso(7200e3) }])];
  const got = [];
  const r = await dm.pollAccountOnce(ig, { onMessage: async (m) => got.push(m) });
  assert.equal(r.ok, true);
  assert.equal(got.length, 0);
  assert.equal(await inbound.hasInbound('instagram', 'old.friend'), true);
  assert.equal(await inbound.hasInbound('instagram', 'stranger'), false);
});

test('a new message is handed to the brain once, as an ig_ conversation', async () => {
  threads = [thread('old.friend', [
    { id: 'm3', text: 'are you free tonight?', from_them: true, at: iso(60e3) },
    { id: 'm2', text: 'you there?', from_them: true, at: iso(3600e3) },
  ])];
  const got = [];
  await dm.pollAccountOnce(ig, { onMessage: async (m) => got.push(m) });
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].id, got[0].platform, got[0].from, got[0].text], ['ig_old.friend', 'instagram', 'old.friend', 'are you free tonight?']);
  await dm.pollAccountOnce(ig, { onMessage: async (m) => got.push(m) });
  assert.equal(got.length, 1, 'the same message is never handled twice');
});

test('her own messages are not treated as inbound, and very old ones are never answered', async () => {
  threads = [thread('new.person', [
    { id: 'a2', text: 'my own reply', from_them: false, at: iso(1000) },
    { id: 'a1', text: 'ancient message', from_them: true, at: iso(48 * 3600e3) },
  ])];
  const got = [];
  await dm.pollAccountOnce(ig, { onMessage: async (m) => got.push(m) });
  assert.equal(got.length, 0);
  assert.equal(await inbound.hasInbound('instagram', 'new.person'), true); // they did write, long ago
});

test('replies go out through the engine as replies (the only DMs she sends)', async () => {
  sent = [];
  await dm.sendText('instagram', 'old.friend', 'yes, free after 8');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.reply, true);
  assert.deepEqual(sent[0].payload, { username: 'old.friend', message: 'yes, free after 8' });
  sent = [];
  await dm.sendText('instagram', 'old.friend', 'x'.repeat(2000));
  assert.equal(sent.length, 3, 'long replies are split');
  await assert.rejects(() => dm.sendText('tiktok', 'someone', 'hi'), /No tiktok account/);
});

test('TikTok polling is off unless asked for', () => {
  delete process.env.TIKTOK_DM_POLL_MIN;
  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  const ctl = dm.init({ onMessage: async () => {} });
  ctl.start(); ctl.stop();
  console.log = orig;
  assert.ok(logs.some((l) => /TikTok DMs: not polled/.test(l)));
});

test('a poll that fails reports why instead of throwing', async () => {
  engine.ig.inbox = async () => ({ ok: false, code: 'session_expired', error: 'expired' });
  const r = await dm.pollAccountOnce(ig, { onMessage: async () => {} });
  assert.deepEqual([r.ok, r.code], [false, 'session_expired']);
});
