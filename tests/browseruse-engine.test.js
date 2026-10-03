'use strict';
// Browser Use as the social engine, tested against a fake Browser Use API (no network, no credits).
process.env.BROWSER_USE_API_KEY = 'bu_test';
process.env.SOCIAL_ACTION_GAP_MS = '0';
delete process.env.SOCIAL_ENGINE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let taskOutput = JSON.stringify({ success: true, data: { posts: ['https://www.instagram.com/p/abc/'] } });
let profiles = [{ id: 'p1', name: 'ariana-instagram-ariana.personal' }];

global.fetch = async (url, opts = {}) => {
  const path = String(url).replace('https://api.browser-use.com/api/v2', '');
  const method = opts.method || 'GET';
  calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null, key: opts.headers && opts.headers['X-Browser-Use-API-Key'] });
  const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
  if (path.startsWith('/profiles') && method === 'GET') return json(200, { items: profiles });
  if (path === '/tasks' && method === 'POST') return json(202, { id: 't1', sessionId: 's1' });
  if (path === '/tasks/t1') return json(200, { id: 't1', status: 'finished', output: taskOutput });
  if (path === '/billing/account') return json(200, { totalCreditsBalanceUsd: 5, concurrentSessionLimit: 3 });
  return json(404, { detail: 'nope' });
};

const engine = require('../social/engine_client');
const account = { account_id: 'instagram:ariana.personal', platform: 'instagram', handle: 'ariana.personal' };

test('BROWSER_USE_API_KEY alone makes the engine configured', () => {
  assert.equal(engine.configured(), true);
  assert.equal(engine.provider(), 'browser-use');
});

test('a read action runs one task with the account profile and returns the data', async () => {
  const r = await engine.act(account, 'view_posts', { username: 'someone' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.posts, ['https://www.instagram.com/p/abc/']);
  const created = calls.find((c) => c.path === '/tasks' && c.method === 'POST');
  assert.equal(created.key, 'bu_test');
  assert.equal(created.body.sessionSettings.profileId, 'p1');
  assert.match(created.body.task, /NEVER type, request or accept a password/);
});

test('a task that reports failure is not counted as done', async () => {
  taskOutput = JSON.stringify({ success: false, code: 'session_expired', error: 'login page' });
  const r = await engine.act(account, 'like', { url: 'https://www.instagram.com/p/abc/' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'session_expired');
});

test('an unreadable result is never counted as done', async () => {
  taskOutput = 'I think it worked!';
  const r = await engine.act(account, 'like', { url: 'https://www.instagram.com/p/abc/' });
  assert.equal(r.ok, false);
});

test('an account with no saved login says so instead of guessing', async () => {
  profiles = [];
  const r = await engine.act(account, 'like', { url: 'https://www.instagram.com/p/abc/' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_session');
});

test('Instagram text posts are refused (it needs an image)', async () => {
  profiles = [{ id: 'p1', name: 'ariana-instagram-ariana.personal' }];
  const r = await engine.act(account, 'post', { text: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsupported');
});

test('health reads the Browser Use account', async () => {
  const r = await engine.health();
  assert.equal(r.ok, true);
  assert.equal(r.health.engine, 'browser-use-cloud');
});
