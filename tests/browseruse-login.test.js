'use strict';
// Sign-in finish flow for the Browser Use engine, against a fake Browser Use API (no network, no credits).
process.env.BROWSER_USE_API_KEY = 'bu_test';
process.env.SOCIAL_ACTION_GAP_MS = '0';
process.env.BU_STOP_POLL_MS = '0';
process.env.BU_PROFILE_SETTLE_MS = '0';
delete process.env.SOCIAL_ENGINE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let browserStatus = 'active';      // what GET /browsers/b1 reports
let stopWorks = true;              // does PATCH action:stop actually end it
let altStopWorks = false;          // does the older {status:'stopped'} body end it
let verifyAnswers = [];            // queue of task outputs for sign-in checks
const profiles = [{ id: 'p1', name: 'ariana-twitter-sexiest_xx' }];

global.fetch = async (url, opts = {}) => {
  const path = String(url).replace('https://api.browser-use.com/api/v2', '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });
  const json = (status, b) => ({ status, ok: status < 400, text: async () => JSON.stringify(b) });
  if (path.startsWith('/profiles') && method === 'GET') return json(200, { items: profiles });
  if (path === '/browsers' && method === 'POST') { browserStatus = 'active'; return json(201, { id: 'b1', liveUrl: 'https://live.browser-use.com/x' }); }
  if (path === '/browsers/b1' && method === 'GET') return json(200, { id: 'b1', status: browserStatus });
  if (path === '/browsers/b1' && method === 'PATCH') {
    if (body && body.action === 'stop' && stopWorks) browserStatus = 'stopped';
    if (body && body.status === 'stopped' && altStopWorks) browserStatus = 'stopped';
    return json(200, { id: 'b1', status: browserStatus });
  }
  if (path === '/tasks' && method === 'POST') return json(202, { id: 't1' });
  if (path === '/tasks/t1') return json(200, { id: 't1', status: 'finished', output: verifyAnswers.shift() });
  return json(404, { detail: 'nope' });
};

const bu = require('../social/browseruse_engine');
const account = { account_id: 'twitter:sexiest_xx', platform: 'twitter', handle: 'sexiest_xx' };
const signedIn = JSON.stringify({ success: true, data: { logged_in: true, handle: '@sexiest_xx' } });
const notSignedIn = JSON.stringify({ success: false, error: 'login page was encountered' });
const reset = () => { calls.length = 0; browserStatus = 'active'; stopWorks = true; altStopWorks = false; verifyAnswers = []; };

test('finishing a login stops the browser and confirms it stopped before reporting ok', async () => {
  reset();
  await bu.startLogin(account);
  const fin = await bu.finishLogin(account);
  assert.equal(fin.ok, true);
  assert.equal(fin.expired, false);
  assert.equal(bu.hasPendingLogin(account), false);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.body.action === 'stop'));
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/browsers/b1'), 'it must poll the browser state');
});

test('a browser that will not stop is an error and stays pending so the user can retry', async () => {
  reset(); stopWorks = false;
  await bu.startLogin(account);
  const fin = await bu.finishLogin(account);
  assert.equal(fin.ok, false);
  assert.equal(fin.code, 'stop_failed');
  assert.equal(bu.hasPendingLogin(account), true);
  stopWorks = true; // retry succeeds
  assert.equal((await bu.finishLogin(account)).ok, true);
});

test('falls back to the older stop body when action:stop does not end the browser', async () => {
  reset(); stopWorks = false; altStopWorks = true;
  await bu.startLogin(account);
  const fin = await bu.finishLogin(account);
  assert.equal(fin.ok, true);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.body && c.body.status === 'stopped'));
});

test('a browser that already timed out is reported as expired, not silently stopped', async () => {
  reset();
  await bu.startLogin(account);
  browserStatus = 'stopped'; // timed out on its own
  const fin = await bu.finishLogin(account);
  assert.equal(fin.ok, true);
  assert.equal(fin.expired, true);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0, 'nothing to stop');
});

test('verify after login retries once before telling the user to sign in again', async () => {
  reset();
  verifyAnswers = [notSignedIn, signedIn];
  const v = await bu.verifyAfterLogin(account, { ok: true, expired: false });
  assert.equal(v.session.connected, true);
  assert.equal(calls.filter((c) => c.path === '/tasks' && c.method === 'POST').length, 2);
});

test('verify after login explains an expired browser when the login really is missing', async () => {
  reset();
  verifyAnswers = [notSignedIn];
  const v = await bu.verifyAfterLogin(account, { ok: true, expired: true });
  assert.equal(v.session.connected, false);
  assert.match(v.session.detail, /timed out/);
  assert.equal(calls.filter((c) => c.path === '/tasks' && c.method === 'POST').length, 1, 'no pointless retry');
});

test('wrong account is not retried', async () => {
  reset();
  verifyAnswers = [JSON.stringify({ success: true, data: { logged_in: true, handle: '@someone_else' } })];
  const v = await bu.verifyAfterLogin(account, { ok: true, expired: false });
  assert.equal(v.session.connected, false);
  assert.match(v.session.detail, /not @sexiest_xx/);
  assert.equal(calls.filter((c) => c.path === '/tasks' && c.method === 'POST').length, 1);
});
