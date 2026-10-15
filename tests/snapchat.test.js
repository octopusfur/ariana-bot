'use strict';
// Snapchat channel adapter against a fake sidecar (no network, no Snapchat account).
const SECRET = 'sc-test-secret';
const CONV = '6e609ac8-04ed-45b8-9dee-002cdaf13db5';
process.env.SNAP_API_SECRET = SECRET;

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const calls = [];
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/status') return send(200, { connected: true, signed_in: true, conversations: [CONV] });
    if (req.url === '/login') return send(200, { cookies: { sc_a: 'x' }, bearer_token: 'tok', connected: true, signed_in: true, user_uuid_set: true });
    if (req.url === '/like') return send(501, { error: 'The upstream library cannot like content yet', supported: false });
    if (req.url === '/send-text' && b.includes('FAIL')) return send(502, { error: 'send failed: grpc-status=7' });
    send(200, { status: 'ok' });
  });
});

let app, server, base, got;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.SNAP_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  const snap = require('../snapchat');
  global.snap = snap;
  app = express();
  app.use(express.json({ limit: '10mb' }));
  got = [];
  snap.init({ app, requireAuth: (_q, _s, n) => n(), getSupabase: () => null, onMessage: async (m) => { got.push(m); } });
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fake.close(); });

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('sendText authenticates to the sidecar and splits long messages', async () => {
  calls.length = 0;
  await snap.sendText(CONV, 'a'.repeat(2300));
  const sends = calls.filter((c) => c.url === '/send-text');
  assert.equal(sends.length, 3);
  assert.ok(sends.every((c) => c.auth === `Bearer ${SECRET}` && c.body.conversation_id === CONV && c.body.text.length <= 1000));
});

test('rejects anything that is not a conversation UUID before calling the sidecar', async () => {
  calls.length = 0;
  await assert.rejects(snap.sendText('+2348012345678', 'hi'), /invalid conversation id/);
  await assert.rejects(snap.sendImage('nope', 'https://x/y.jpg', ''), /invalid conversation id/);
  assert.equal(calls.length, 0);
});

test('a sidecar failure surfaces as an error instead of silently succeeding', async () => {
  await assert.rejects(snap.sendText(CONV, 'FAIL'), /Snapchat: send failed/);
});

test('inbound webhook needs the shared secret', async () => {
  got.length = 0;
  assert.equal((await post('/snapchat/inbound', { conversation_id: CONV, text: 'hi' })).status, 401);
  assert.equal((await post('/snapchat/inbound', { conversation_id: CONV, text: 'hi' }, { 'x-snap-secret': 'wrong' })).status, 401);
  assert.equal(got.length, 0);
});

test('inbound webhook hands a snapchat message to the brain with an sc_ id, once', async () => {
  got.length = 0;
  const h = { 'x-snap-secret': SECRET };
  assert.equal((await post('/snapchat/inbound', { conversation_id: CONV.toUpperCase(), text: ' hey ariana ' }, h)).status, 200);
  assert.equal((await post('/snapchat/inbound', { conversation_id: CONV, text: 'hey ariana' }, h)).status, 200); // retry
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 1);
  assert.deepEqual({ id: got[0].id, platform: got[0].platform, from: got[0].from, text: got[0].text }, { id: `sc_${CONV}`, platform: 'snapchat', from: CONV, text: 'hey ariana' });
});

test('inbound webhook rejects malformed bodies', async () => {
  const h = { 'x-snap-secret': SECRET };
  assert.equal((await post('/snapchat/inbound', { conversation_id: 'x', text: 'hi' }, h)).status, 400);
  assert.equal((await post('/snapchat/inbound', { conversation_id: CONV, text: '  ' }, h)).status, 400);
});

test('status and unsupported features pass through with their real status codes', async () => {
  const st = await (await fetch(base + '/api/snapchat/status')).json();
  assert.equal(st.configured, true);
  assert.equal(st.connected, true);
  const like = await post('/api/snapchat/like', { content_id: 'x' });
  assert.equal(like.status, 501);
  assert.match((await like.json()).error, /cannot like/);
});

test('sendImage downloads the picture and uploads it to the sidecar as base64', async () => {
  const img = http.createServer((_q, s) => { s.writeHead(200, { 'Content-Type': 'image/jpeg' }); s.end(Buffer.from([1, 2, 3, 4])); });
  await new Promise((r) => img.listen(0, '127.0.0.1', r));
  calls.length = 0;
  await snap.sendImage(CONV, `http://127.0.0.1:${img.address().port}/selfie.jpg?x=1`, 'for you');
  img.close();
  const media = calls.find((c) => c.url === '/send-media');
  assert.equal(media.body.filename, 'selfie.jpg');
  assert.equal(media.body.data_b64, Buffer.from([1, 2, 3, 4]).toString('base64'));
  assert.ok(calls.some((c) => c.url === '/send-text' && c.body.text === 'for you'));
});

test('sign-in stores the session in Supabase (type snapchat) and never stores the password', async () => {
  const rows = [];
  const sb = {
    from: (table) => {
      assert.equal(table, 'sessions');
      const q = { _f: {} };
      q.select = () => q;
      q.eq = (k, v) => { q._f[k] = v; return q; };
      q.maybeSingle = async () => ({ data: rows.find((r) => r.type === q._f.type && r.key === q._f.key) || null });
      q.upsert = async (row, opt) => { assert.equal(opt.onConflict, 'type,key'); const i = rows.findIndex((r) => r.type === row.type && r.key === row.key); if (i >= 0) rows[i] = row; else rows.push(row); return { error: null }; };
      return q;
    },
  };
  const app2 = express();
  app2.use(express.json());
  snap.init({ app: app2, requireAuth: (_q, _s, n) => n(), getSupabase: () => sb, onMessage: async () => {} });
  const srv = await new Promise((r) => { const x = app2.listen(0, '127.0.0.1', () => r(x)); });
  const b2 = `http://127.0.0.1:${srv.address().port}`;
  const UUID = '2510ebad-9409-5ab9-bfaf-e80838f7077f';
  const r = await (await fetch(b2 + '/api/snapchat/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ari', password: 'hunter2-secret', userUuid: UUID.toUpperCase() }) })).json();
  assert.equal(r.saved, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'snapchat');
  assert.equal(rows[0].key, 'default');
  assert.deepEqual(rows[0].data.cookies, { sc_a: 'x' });
  assert.equal(rows[0].data.user_uuid, UUID);
  assert.ok(!JSON.stringify(rows).includes('hunter2-secret'), 'password must never be persisted');
  const st = await (await fetch(b2 + '/api/snapchat/status')).json();
  assert.equal(st.saved, true);
  srv.close();
});
