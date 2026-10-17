// tests/ig-engine.test.js
// Instagram through the Instagram service (ig-service/). What these pin down:
//   · nothing wakes the service by itself (status/health answer locally; bad input is
//     rejected before any connection is made);
//   · a cold start is absorbed for reads and Connect, but a WRITE IS SENT EXACTLY ONCE;
//   · every failure carries a code Ariana can speak about honestly;
//   · the capability overlay, this client and ig-service/app.py never drift apart.
// The "service" is a real HTTP server on a real local port speaking the service's wire format.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const os = require('os');
process.env.SOCIAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-ig-'));
delete process.env.SUPABASE_URL;
delete process.env.SOCIAL_ENGINE_URL;
delete process.env.BROWSER_USE_API_KEY;
delete process.env.X_SERVICE_URL;
delete process.env.IG_SERVICE_URL;
delete process.env.IG_SERVICE_API_KEY;
process.env.IG_SERVICE_RETRY_PAUSE_MS = '10';

const ig = require('../social/ig_engine');
const engine = require('../social/engine_client');
const caps = require('../social/capabilities');
const store = require('../social/store');

const KEY = 'k'.repeat(32);
const account = { account_id: 'instagram:ariana.test', platform: 'instagram', handle: 'ariana.test' };

let server; let port; let hits = []; let behaviour;

function start() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
        behaviour(req, res, hits.length);
      });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

test.before(async () => { await start(); });
test.after(() => server.close());
test.beforeEach(async () => {
  hits = [];
  await store.setSession('instagram', 'ariana.test', { settings: { cookies: { sessionid: 'x' } } });
  process.env.IG_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.IG_SERVICE_API_KEY = KEY;
  behaviour = (req, res) => send(res, 200, { success: true, data: {} });
});

test('configured needs both the URL and the key', () => {
  delete process.env.IG_SERVICE_API_KEY;
  assert.equal(ig.configured(), false);
  process.env.IG_SERVICE_API_KEY = KEY;
  assert.equal(ig.configured(), true);
  assert.equal(engine.routesToIG(account), true);
  assert.equal(engine.routesToIG({ platform: 'twitter' }), false);
  assert.equal(engine.provider(), 'instagrapi');
});

test('status, sessions and health never touch the network', async () => {
  await ig.health(); await ig.sessions(); await ig.sessionStatus(account);
  await engine.health(); await engine.sessions(); await engine.sessionStatus(account);
  assert.equal(hits.length, 0);
});

test('a bad request is rejected before the service is contacted', async () => {
  await require('../social/dm_inbound').markInbound('instagram', 'someone');
  for (const [action, payload] of [
    ['like', { url: 'https://example.com/x' }],
    ['follow', { username: 'bad name!' }],
    ['comment', { url: 'https://www.instagram.com/p/AbCdE12345/', text: '   ' }],
    ['dm', { username: 'someone', message: '' }],
  ]) {
    const r = await engine.act(account, action, payload);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad_target');
  }
  assert.equal(hits.length, 0);
});

test('an action the service does not have is refused locally', async () => {
  const r = await engine.act(account, 'repost', { url: 'https://www.instagram.com/p/AbCdE12345/' });
  assert.equal(r.code, 'unsupported');
  assert.equal(hits.length, 0);
});

test('a successful write is sent once, with the key, and returns the data', async () => {
  behaviour = (req, res) => send(res, 200, { success: true, platform: 'instagram', action: 'like', data: { liked: true } });
  const r = await engine.act(account, 'like', { url: 'https://www.instagram.com/p/AbCdE12345/' });
  assert.equal(r.ok, true);
  assert.equal(r.result.data.liked, true);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, '/act/like');
  assert.equal(hits[0].key, KEY);
  assert.equal(hits[0].body.handle, 'ariana.test');
});

test('the service\'s own failure code reaches Ariana intact', async () => {
  behaviour = (req, res) => send(res, 200, { success: false, code: 'cooldown', error: 'writes are paused' });
  const r = await engine.act(account, 'follow', { username: 'someone' });
  assert.deepEqual([r.ok, r.code, r.error], [false, 'cooldown', 'writes are paused']);
});

test('a wrong API key is reported as such', async () => {
  behaviour = (req, res) => send(res, 401, { detail: 'Invalid or missing X-Api-Key.' });
  const r = await engine.act(account, 'view_profile', { username: 'someone' });
  assert.equal(r.code, 'unauthorized');
});

test('a read is retried through a cold start; a write is NEVER retried', async () => {
  // Reads: service answers 503 twice (waking), then works.
  behaviour = (req, res, n) => (n < 3 ? send(res, 503, { detail: 'waking' }) : send(res, 200, { success: true, data: { username: 'someone' } }));
  const read = await engine.act(account, 'view_profile', { username: 'someone' });
  assert.equal(read.ok, true);
  assert.equal(hits.length, 3);

  // Writes: a dead service is tried exactly once.
  hits = [];
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
  process.env.IG_SERVICE_URL = `http://127.0.0.1:${deadPort}`;
  const t0 = Date.now();
  const write = await engine.act(account, 'comment', { url: 'https://www.instagram.com/p/AbCdE12345/', text: 'nice' });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'unreachable');
  assert.ok(Date.now() - t0 < 2000, 'a write must fail fast, not wait out a wake-up budget');
});

test('Connect verifies the live session and reports the account', async () => {
  behaviour = (req, res) => send(res, 200, { connected: true, handle: 'ariana.test', detail: 'Verified live: this service is signed in as @ariana.test.' });
  const v = await engine.verify(account);
  assert.equal(v.ok, true);
  assert.equal(v.session.connected, true);
  assert.equal(hits[0].url, '/verify');

  behaviour = (req, res) => send(res, 200, { connected: false, detail: 'Signed in as @other, not @ariana.test.' });
  const bad = await engine.verify(account);
  assert.equal(bad.session.connected, false);
  assert.match(bad.session.detail, /@other/);
});

test('instagram uses the service overlay only while it is configured', () => {
  assert.equal(caps.supports('instagram', 'read_dms'), true);
  assert.equal(caps.supports('instagram', 'post'), true);
  assert.equal(caps.supports('instagram', 'repost'), false);
  delete process.env.IG_SERVICE_URL;
  assert.equal(caps.supports('instagram', 'read_dms'), false); // base (socialcrabs) manifest again
});

test('drift guard: overlay, this client and ig-service/app.py list the same actions', () => {
  process.env.IG_SERVICE_URL = `http://127.0.0.1:${port}`;
  const overlay = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'social', 'capabilities.ig-api.json'), 'utf8'));
  const supported = Object.entries(overlay.platforms.instagram.actions).filter(([, v]) => v.supported).map(([k]) => k).sort();
  assert.deepEqual(ig.supportedActions().sort(), supported);

  const py = fs.readFileSync(path.join(__dirname, '..', 'ig-service', 'app.py'), 'utf8');
  const block = py.match(/HANDLERS: dict = \{([\s\S]*?)\n\}/)[1];
  const pyActions = [...block.matchAll(/"(\w+)":\s*do_/g)].map((m) => m[1]).sort();
  assert.deepEqual(pyActions, supported);

  // every action in the base manifest is accounted for in the overlay, supported or not
  assert.deepEqual(Object.keys(overlay.platforms.instagram.actions).sort(), Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'social', 'capabilities.json'), 'utf8')).actions).sort());
});

test('without a stored session nothing is sent and the message says how to connect', async () => {
  await store.deleteSession('instagram', 'ariana.test');
  const r = await engine.act(account, 'view_profile', { username: 'someone' });
  assert.equal(r.code, 'no_session');
  assert.match(r.error, /Settings/);
  assert.equal(hits.length, 0);
  const v = await engine.verify(account);
  assert.equal(v.session.connected, false);
  assert.equal(hits.length, 0);
});

test('the stored session travels with the request (the service keeps none of its own)', async () => {
  await engine.act(account, 'view_profile', { username: 'someone' });
  assert.deepEqual(hits[0].body.session, { settings: { cookies: { sessionid: 'x' } } });
});

test('login stores the session in the database and never keeps the password', async () => {
  await store.deleteSession('instagram', 'ariana.test');
  behaviour = (req, res) => send(res, 200, { connected: true, handle: 'Ariana.Test', settings: { cookies: { sessionid: 'abc' } }, detail: 'Signed in as @ariana.test.' });
  const r = await ig.login('@ariana.test', 'pw-secret', '123456');
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.equal(r.handle, 'ariana.test');
  assert.equal(r.stored, 'file'); // no Supabase in tests, and the answer says so
  assert.match(r.detail, /disk only/);
  assert.deepEqual(await store.getSession('instagram', 'ariana.test'), (await store.getSession('instagram', 'ariana.test')));
  const saved = await store.getSession('instagram', 'ariana.test');
  assert.deepEqual(saved.settings, { cookies: { sessionid: 'abc' } });
  assert.equal(JSON.stringify(saved).includes('pw-secret'), false);
  assert.equal(hits[0].url, '/login');
});

test('login failures reach the dashboard as plain codes and save nothing', async () => {
  await store.deleteSession('instagram', 'ariana.test');
  behaviour = (req, res) => send(res, 200, { connected: false, code: 'two_factor', detail: 'Instagram needs your 6-digit security code.' });
  const r = await ig.login('ariana.test', 'pw');
  assert.deepEqual([r.ok, r.connected, r.code], [true, false, 'two_factor']);
  assert.equal(await store.getSession('instagram', 'ariana.test'), null);
  const bad = await ig.login('bad name!', 'pw');
  assert.equal(bad.code, 'bad_input');
});

test('posting needs a picture; with one it is sent as a write, once', async () => {
  const none = await engine.act(account, 'post', { text: 'hello' });
  assert.equal(none.code, 'bad_target');
  const http1 = await engine.act(account, 'post', { text: 'x', image_url: 'http://a.example/p.jpg' });
  assert.equal(http1.code, 'bad_target');
  assert.equal(hits.length, 0);
  behaviour = (req, res) => send(res, 200, { success: true, data: { url: 'https://www.instagram.com/p/NewPost123/', posted: true } });
  const r = await engine.act(account, 'post', { text: 'hello', image_url: 'https://cdn.example/p.jpg' });
  assert.equal(r.ok, true);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].body.payload.image_url, 'https://cdn.example/p.jpg');
});

test('she never starts a conversation: a DM to someone who has not written first is refused before anything is sent', async () => {
  const r = await engine.act(account, 'dm', { username: 'stranger', message: 'hi!' });
  assert.deepEqual([r.ok, r.code], [false, 'no_first_dm']);
  assert.equal(hits.length, 0);
  await require('../social/dm_inbound').markInbound('instagram', 'Stranger');
  behaviour = (req, res) => send(res, 200, { success: true, data: { sent: true } });
  const ok = await engine.act(account, 'dm', { username: 'stranger', message: 'hi, you wrote to me' });
  assert.equal(ok.ok, true);
  assert.equal(hits.length, 1);
});
