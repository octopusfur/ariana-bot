'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { register, loadLinkedSessions, cleanPhone } = require('../link_routes');

function fakeSupabase() {
  const rows = [];
  return {
    rows,
    from: () => ({
      upsert: async (row) => { const i = rows.findIndex(r => r.type === row.type && r.key === row.key); if (i >= 0) rows[i] = row; else rows.push(row); return { error: null }; },
      delete: () => ({ eq: () => ({ eq: async () => ({}) }) }),
      select: () => ({ in: () => ({ eq: async () => ({ data: rows }) }) }),
    }),
  };
}

async function boot({ http, tgLib, supabase = fakeSupabase() } = {}) {
  const state = { number: '', reinit: 0, client: null };
  const app = express(); app.use(express.json());
  register(app, {
    requireAuth: (req, res, next) => (req.headers['x-dashboard-key'] === 'pw' ? next() : res.status(401).json({ error: 'no' })),
    getSupabase: () => supabase,
    http: http || { get: async () => ({ data: [] }), post: async () => ({ data: {} }) },
    telegram: { getClient: () => state.client, reinit: async () => { state.reinit++; }, lib: tgLib, sessions: { StringSession: class { constructor(s) { this.s = s; } save() { return 'SESSION-STRING'; } } } },
    signal: { getUrl: () => 'http://sig', getNumber: () => state.number, setNumber: async (n) => { state.number = n; } },
  });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Dashboard-Key': 'pw' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  return { call, state, supabase, port: server.address().port, close: () => server.close() };
}

test('cleanPhone normalises and rejects junk', () => {
  assert.strictEqual(cleanPhone('+1 (430) 362-9477'), '+14303629477');
  assert.strictEqual(cleanPhone('123'), null);
});

test('routes require the dashboard key', async () => {
  const t = await boot();
  const app = express(); app.use(express.json());
  t.close();
  // wrong key → 401 through the injected middleware
  const t2 = await boot();
  const res = await fetch(`http://127.0.0.1:${t2.port}/api/signal/status`, { headers: { 'X-Dashboard-Key': 'nope' } });
  assert.strictEqual(res.status, 401);
  t2.close();
});

test('signal status reports linked only when the configured number is registered', async () => {
  const t = await boot({ http: { get: async () => ({ data: ['+14303629477'] }), post: async () => ({}) } });
  t.state.number = '+14303629477';
  assert.deepStrictEqual((await t.call('GET', '/api/signal/status')).json.linked, true);
  t.state.number = '+19999999999';
  assert.deepStrictEqual((await t.call('GET', '/api/signal/status')).json.linked, false);
  t.close();
});

test('signal link prefers the tappable sgnl:// URI and falls back to the QR image', async () => {
  const uri = 'sgnl://linkdevice?uuid=abc&pub_key=def';
  let t = await boot({ http: { get: async (u) => ({ data: u.includes('/raw') ? uri : null }) } });
  assert.strictEqual((await t.call('GET', '/api/signal/link')).json.uri, uri);
  t.close();
  t = await boot({ http: { get: async (u) => { if (u.includes('/raw')) throw new Error('404'); return { data: Buffer.from('png') }; } } });
  assert.match((await t.call('GET', '/api/signal/link')).json.qr, /^data:image\/png;base64,/);
  t.close();
});

test('signal verify stores the number and persists it', async () => {
  const t = await boot({ http: { get: async () => ({ data: [] }), post: async () => ({ data: {} }) } });
  const r = await t.call('POST', '/api/signal/verify', { number: '+1 430 362 9477', code: '123-456' });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(t.state.number, '+14303629477');
  assert.deepStrictEqual(t.supabase.rows[0].data, { number: '+14303629477' });
  t.close();
});

test('signal register surfaces a captcha requirement', async () => {
  const err = Object.assign(new Error('x'), { response: { status: 400, data: { error: 'Captcha required for verification' } } });
  const t = await boot({ http: { get: async () => ({}), post: async () => { throw err; } } });
  const r = await t.call('POST', '/api/signal/register', { number: '+14303629477' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.needCaptcha, true);
  t.close();
});

test('telegram: code → session saved, secret not echoed, client restarted', async () => {
  const fakeClient = { connect: async () => {}, disconnect: async () => {}, sendCode: async () => ({ phoneCodeHash: 'H', isCodeViaApp: true }), invoke: async () => ({}), session: { save: () => 'SESSION-STRING' } };
  const tgLib = { TelegramClient: function () { return fakeClient; }, Api: { auth: { SignIn: function (o) { Object.assign(this, o); } } } };
  process.env.TELEGRAM_API_ID = '123'; process.env.TELEGRAM_API_HASH = 'hash';
  const t = await boot({ tgLib });
  assert.strictEqual((await t.call('POST', '/api/telegram/send-code', { phone: '+2348012345678' })).json.viaApp, true);
  const v = await t.call('POST', '/api/telegram/verify', { code: '12345' });
  assert.strictEqual(v.json.ok, true);
  assert.strictEqual(v.json.persisted, true);
  assert.strictEqual(v.json.session, undefined);
  assert.strictEqual(t.state.reinit, 1);
  assert.strictEqual(process.env.TELEGRAM_SESSION, 'SESSION-STRING');
  assert.deepStrictEqual(t.supabase.rows[0], { ...t.supabase.rows[0], type: 'telegram', data: { session: 'SESSION-STRING' } });
  t.close();
});

test('telegram: 2FA accounts get asked for the password, then link', async () => {
  let signedInWithPw = false;
  const fakeClient = {
    connect: async () => {}, disconnect: async () => {}, sendCode: async () => ({ phoneCodeHash: 'H' }),
    invoke: async () => { throw Object.assign(new Error('x'), { errorMessage: 'SESSION_PASSWORD_NEEDED' }); },
    signInWithPassword: async (_c, o) => { assert.strictEqual(await o.password(), 'pw2'); signedInWithPw = true; },
    session: { save: () => 'S2' },
  };
  const tgLib = { TelegramClient: function () { return fakeClient; }, Api: { auth: { SignIn: function () {} } } };
  process.env.TELEGRAM_API_ID = '123'; process.env.TELEGRAM_API_HASH = 'hash';
  const t = await boot({ tgLib });
  await t.call('POST', '/api/telegram/send-code', { phone: '+2348012345678' });
  assert.strictEqual((await t.call('POST', '/api/telegram/verify', { code: '12345' })).json.needPassword, true);
  const r = await t.call('POST', '/api/telegram/verify', { code: '12345', password: 'pw2' });
  assert.strictEqual(r.json.ok, true);
  assert.ok(signedInWithPw);
  t.close();
});

test('loadLinkedSessions reads telegram + signal rows', async () => {
  const sb = fakeSupabase();
  sb.rows.push({ type: 'telegram', key: 'default', data: { session: 'abc' } }, { type: 'signal', key: 'default', data: { number: '+1555' } });
  assert.deepStrictEqual(await loadLinkedSessions(sb), { telegramSession: 'abc', signalNumber: '+1555' });
});
