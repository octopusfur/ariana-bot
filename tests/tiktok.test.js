'use strict';
// TikTok runs only through Browser Use Cloud. Pins down: it is offered only then, and the
// browser tasks say "video", keep the no-password rule, and refuse what TikTok cannot do here.
process.env.BROWSER_USE_API_KEY = 'bu_test';
process.env.SOCIAL_ACTION_GAP_MS = '0';
process.env.SOCIAL_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ariana-tt-'));
delete process.env.SUPABASE_URL;
delete process.env.SOCIAL_ENGINE_URL;
delete process.env.IG_SERVICE_URL;
delete process.env.X_SERVICE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let taskOutput = JSON.stringify({ success: true, data: { posts: ['https://www.tiktok.com/@a/video/1'] } });
global.fetch = async (url, opts = {}) => {
  const p = String(url).replace('https://api.browser-use.com/api/v2', '');
  const method = opts.method || 'GET';
  calls.push({ method, path: p, body: opts.body ? JSON.parse(opts.body) : null });
  const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
  if (p.startsWith('/profiles') && method === 'GET') return json(200, { items: [{ id: 'p9', name: 'ariana-tiktok-ariana.tt' }] });
  if (p === '/tasks' && method === 'POST') return json(202, { id: 't1' });
  if (p === '/tasks/t1') return json(200, { id: 't1', status: 'finished', output: taskOutput });
  return json(404, { detail: 'nope' });
};

const engine = require('../social/engine_client');
const caps = require('../social/capabilities');
const account = { account_id: 'tiktok:ariana.tt', platform: 'tiktok', handle: 'ariana.tt' };

test('TikTok is offered while Browser Use is the engine', () => {
  assert.ok(caps.platformIds().includes('tiktok'));
  assert.equal(caps.supports('tiktok', 'like'), true);
  assert.equal(caps.supports('tiktok', 'post'), false);
  assert.match(caps.unsupportedReason('tiktok', 'post'), /video file/);
  assert.equal(caps.describe().unsupported_platforms.some((p) => p.id === 'tiktok'), false);
});

test('TikTok is not offered with the self-hosted engine, which has no TikTok handler', () => {
  process.env.SOCIAL_ENGINE_URL = 'http://engine.invalid';
  assert.equal(caps.platformIds().includes('tiktok'), false);
  assert.equal(caps.describe().unsupported_platforms.some((p) => p.id === 'tiktok'), true);
  delete process.env.SOCIAL_ENGINE_URL;
});

test('a TikTok like is one browser task that talks about the video and forbids credentials', async () => {
  const r = await engine.act(account, 'like', { url: 'https://www.tiktok.com/@a/video/1' });
  assert.equal(r.ok, true);
  const task = calls.find((c) => c.path === '/tasks').body;
  assert.match(task.task, /TikTok video/);
  assert.match(task.task, /NEVER type, request or accept a password/);
  assert.equal(task.sessionSettings.profileId, 'p9');
  assert.match(task.startUrl, /tiktok\.com/);
});

test('what TikTok cannot do here is refused, not attempted', async () => {
  const r = await engine.act(account, 'post', { text: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsupported');
  const n = calls.filter((c) => c.path === '/tasks').length;
  const r2 = await engine.act(account, 'view_feed', {});
  assert.equal(r2.code, 'unsupported');
  assert.equal(calls.filter((c) => c.path === '/tasks').length, n);
});

test('on TikTok too, unfollowing and replying need no yes each time — but a first DM is refused', async () => {
  const guards = require('../social/guards');
  const accts = require('../social/accounts');
  const added = await accts.add({ platform: 'tiktok', handle: 'ariana.tt', actionsEnabled: true });
  const real = added.ok ? added.account : await accts.get('tiktok:ariana.tt');
  const g = await guards.check({ account: real, action: 'unfollow', count: 1 });
  assert.equal(g.ok, true, g.error);
  const dm = await engine.act(account, 'dm', { username: 'stranger', message: 'hello' });
  assert.deepEqual([dm.ok, dm.code], [false, 'no_first_dm']);
  assert.equal(calls.filter((c) => c.path === '/tasks').length >= 0, true);
});

test('the TikTok reply task only replies in an existing conversation', async () => {
  await require('../social/dm_inbound').markInbound('tiktok', 'fan');
  const before = calls.length;
  await engine.act(account, 'dm', { username: 'fan', message: 'thanks!' });
  const task = calls.slice(before).find((c) => c.path === '/tasks').body.task;
  assert.match(task, /existing TikTok conversation/);
  assert.match(task, /no_first_dm/);
});
