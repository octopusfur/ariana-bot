// tests/social-screen.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The Social screen must never come up blank, and must always let you add and
// sign in an account.
//
// What went wrong once: a capabilities endpoint handed the dashboard a bare list
// of site names. The dashboard called `.supported.map(...)` on each, threw, and
// everything under the engine card (accounts, activity, autonomy) stayed empty —
// so there was nowhere to add or sign in an account. These tests run the REAL
// dashboard code from public/index.html against the payloads the engine sends,
// including the verification-code box that appears when X asks for a code.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-social-screen-'));
process.env.SOCIAL_DATA_DIR = TMP;
delete process.env.SUPABASE_URL;

const express = require('express');
const xengine = require('../social/x_engine');
const api = require('../social/api');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// ── THE REAL DASHBOARD CODE, IN A SANDBOX ───────────────────────────────────

function loadScreen() {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('let soc={'));
  const endFn = lines.findIndex((l) => l.startsWith('async function socConfirmAction'));
  assert.ok(start > 0 && endFn > start, 'the Social block moved — update this test');
  let end = endFn; while (end < lines.length && !/^}/.test(lines[end])) end++; // closing brace of socConfirmAction
  const code = lines.slice(start, end + 1).join('\n');

  const els = {};
  const el = (id) => els[id] || (els[id] = { innerHTML: '', style: {}, value: '' });
  const toasts = [];
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    escHTML: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    plainErr: (s) => s, authH: () => ({}), toast: (m) => toasts.push(m),
    window: { open() {} }, console: { error() {}, log() {} },
    fetch: async () => ({ json: async () => ({}) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(code + ';this.soc=soc;this.renderSocial=renderSocial;this.socConnect=socConnect;this.socSubmitCode=socSubmitCode;this.socPost=socPost;', sandbox);
  return { sandbox, els, toasts };
}

const connectedX = {
  engine: { configured: true, reachable: true, health: { provider: 'x-lite', engine: 'in-process (no browser)', sessions: 1, session_storage: 'supabase (encrypted)', login_configured: true } },
  storage: { supabase: true },
};
const described = (ids) => ({ capabilities: { platforms: ids.map((id) => ({ id, label: id, handle_label: 'handle', supported: [{ action: 'dm' }], unsupported: [{ action: 'search', reason: 'not possible' }] })) } });

function draw(status, caps, accounts = []) {
  const { sandbox, els, toasts } = loadScreen();
  sandbox.soc.status = status; sandbox.soc.caps = caps; sandbox.soc.accounts = accounts; sandbox.soc.activity = [];
  sandbox.renderSocial();
  return { sandbox, els, toasts, accountsHtml: els['social-accounts'].innerHTML, strip: els['social-engine'].innerHTML };
}
const addRows = (html) => (html.match(/socAdd\('(\w+)'\)/g) || []).map((x) => x.slice(8, -2));
const acct = { account_id: 'twitter:ariana', platform: 'twitter', handle: 'ariana', status: 'not_connected', actions_enabled: false, capabilities: { supported: [], unsupported: [] } };

// ── THE BUG ─────────────────────────────────────────────────────────────────

test('a bare list of site names no longer blanks the screen: the X Add row is drawn', () => {
  const { accountsHtml } = draw(connectedX, { capabilities: { provider: 'x-lite', platforms: ['twitter'] } });
  assert.deepStrictEqual(addRows(accountsHtml), ['twitter'], 'you can add an X account even when the list is malformed');
});

test('every malformed capability shape still leaves the Add row in place', () => {
  for (const [label, caps] of [
    ['missing', null],
    ['empty object', { capabilities: {} }],
    ['keyed object, not a list', { capabilities: { platforms: { twitter: {} } } }],
    ['empty list', { capabilities: { platforms: [] } }],
    ['list of junk', { capabilities: { platforms: [null, 7, 'x', {}] } }],
  ]) {
    const { accountsHtml } = draw(connectedX, caps);
    assert.deepStrictEqual(addRows(accountsHtml), ['twitter'], label);
  }
});

test('a good capability list is used as sent', () => {
  const { accountsHtml } = draw(connectedX, described(['twitter']));
  assert.deepStrictEqual(addRows(accountsHtml), ['twitter']);
  assert.match(accountsHtml, /<b>Can:<\/b> dm/);
  assert.match(accountsHtml, /Why not/);
});

test('one section failing never blanks the others', () => {
  const { sandbox, els } = loadScreen();
  sandbox.soc.status = connectedX; sandbox.soc.caps = described(['twitter']);
  sandbox.soc.activity = [{ get status() { throw new Error('boom'); } }]; // breaks the activity list only
  sandbox.renderSocial();
  assert.match(els['social-engine'].innerHTML, /Engine connected/);
  assert.deepStrictEqual(addRows(els['social-accounts'].innerHTML), ['twitter']);
  assert.match(els['social-activity'].innerHTML, /Could not draw this part/);
  assert.ok(els['social-autonomy'].innerHTML !== undefined);
});

test('the engine card says what the engine really is: built in, no browser, saved logins', () => {
  const { strip } = draw(connectedX, described(['twitter']));
  const text = strip.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Built-in X engine \(no browser\) · 1 saved login · logins: supabase \(encrypted\) · state in Supabase/);
  assert.ok(!/browser\(s\) open/.test(text));
  assert.ok(!/credit/.test(text), 'there is no paid cloud browser any more');
});

test('the engine card warns when the server has no X password set', () => {
  const noLogin = { engine: { configured: true, reachable: true, health: { provider: 'x-lite', sessions: 0, session_storage: 'supabase (encrypted)', login_configured: false } }, storage: { supabase: true } };
  const { strip } = draw(noLogin, described(['twitter']));
  assert.match(strip, /server login not set/);
});

test('the autonomy card no longer offers Instagram or LinkedIn inputs', () => {
  const { sandbox, els } = loadScreen();
  sandbox.soc.status = connectedX; sandbox.soc.caps = described(['twitter']);
  sandbox.soc.autonomy = { enabled: false, interval_minutes: 180, max_actions_per_tick: 2 };
  sandbox.renderSocial();
  const html = els['social-autonomy'].innerHTML;
  assert.ok(!/Instagram|LinkedIn/.test(html));
  assert.match(html, /post reader/);
});

// ── SIGNING IN ──────────────────────────────────────────────────────────────

test('sign-in: when X asks for a code, a code box appears on that account card', async () => {
  const { sandbox, els, toasts } = loadScreen();
  sandbox.soc.status = connectedX; sandbox.soc.caps = described(['twitter']); sandbox.soc.accounts = [acct]; sandbox.soc.activity = [];
  sandbox.socPost = async () => ({ ok: true, connected: false, needs_code: true, kind: 'email_code', prompt: 'Check your email for a confirmation code.' });
  vm.runInContext('socPost = this.socPost', sandbox);
  await sandbox.socConnect('twitter:ariana');
  sandbox.renderSocial();
  const html = els['social-accounts'].innerHTML;
  assert.match(html, /Check your email for a confirmation code\./);
  assert.match(html, /id="soc-code-twitter:ariana"/);
  assert.match(html, /socSubmitCode\('twitter:ariana'\)/);
  assert.match(toasts.join(' '), /verification code/);
});

test('sign-in: whatever X says in the code prompt is escaped, never run', async () => {
  const { sandbox, els } = loadScreen();
  sandbox.soc.status = connectedX; sandbox.soc.caps = described(['twitter']); sandbox.soc.accounts = [acct]; sandbox.soc.activity = [];
  sandbox.socPost = async () => ({ ok: true, needs_code: true, prompt: '<img src=x onerror=alert(1)>' });
  vm.runInContext('socPost = this.socPost', sandbox);
  await sandbox.socConnect('twitter:ariana');
  sandbox.renderSocial();
  assert.ok(!/<img src=x/.test(els['social-accounts'].innerHTML));
});

test('sign-in: submitting the code posts it, and success removes the box', async () => {
  const { sandbox, els, toasts } = loadScreen();
  sandbox.soc.status = connectedX; sandbox.soc.caps = described(['twitter']); sandbox.soc.accounts = [acct]; sandbox.soc.activity = [];
  sandbox.soc.code['twitter:ariana'] = { prompt: 'Enter the code' };
  const posted = [];
  sandbox.socPost = async (url, body) => { posted.push({ url, body }); return { ok: true, connected: true }; };
  vm.runInContext('socPost = this.socPost', sandbox);
  els['soc-code-twitter:ariana'] = { innerHTML: '', style: {}, value: ' 123456 ' };
  await sandbox.socSubmitCode('twitter:ariana');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(posted)), [{ url: '/api/social/accounts/twitter%3Aariana/code', body: { code: '123456' } }]); // JSON round-trip: the sandbox is a separate realm
  assert.equal(sandbox.soc.code['twitter:ariana'], undefined);
  assert.match(toasts.join(' '), /Connected/);
  sandbox.soc.accounts = [{ ...acct, status: 'online' }];
  sandbox.renderSocial();
  assert.ok(!/soc-code-/.test(els['social-accounts'].innerHTML));
});

test('sign-in: an empty code is not sent', async () => {
  const { sandbox, els, toasts } = loadScreen();
  const posted = [];
  sandbox.socPost = async (...a) => { posted.push(a); return { ok: true }; };
  vm.runInContext('socPost = this.socPost', sandbox);
  els['soc-code-twitter:ariana'] = { innerHTML: '', style: {}, value: '   ' };
  await sandbox.socSubmitCode('twitter:ariana');
  assert.equal(posted.length, 0);
  assert.match(toasts.join(' '), /Enter the code/);
});

test('sign-in: a failed connect shows the reason and keeps the details open', async () => {
  const { sandbox, toasts } = loadScreen();
  sandbox.soc.status = connectedX; sandbox.soc.caps = described(['twitter']); sandbox.soc.accounts = [acct]; sandbox.soc.activity = [];
  sandbox.socPost = async () => ({ ok: false, error: 'No X login is set on the server.' });
  vm.runInContext('socPost = this.socPost', sandbox);
  await sandbox.socConnect('twitter:ariana');
  assert.match(toasts.join(' '), /No X login is set/);
  assert.equal(sandbox.soc.details['twitter:ariana'], true);
});

// ── THE ENGINE SIDE ─────────────────────────────────────────────────────────

test('the built-in engine answers in the shape the dashboard draws, and names itself', async () => {
  const caps = (await xengine.capabilities()).capabilities;
  assert.ok(api.usableManifest(caps));
  assert.deepStrictEqual(caps.platforms.map((p) => p.id), ['twitter']);
  const h = await xengine.health();
  assert.equal(h.health.provider, 'x-lite');
  assert.equal(typeof h.health.sessions, 'number');
});

test('usableManifest accepts only what the dashboard can draw', () => {
  assert.equal(api.usableManifest(described(['twitter']).capabilities), true);
  for (const bad of [null, {}, { platforms: [] }, { platforms: ['twitter'] }, { platforms: { twitter: {} } }, { platforms: [{ id: 'x' }] }, { platforms: [{ id: 'x', supported: [] }] }]) {
    assert.equal(api.usableManifest(bad), false, JSON.stringify(bad));
  }
});

function call(app, route) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      http.get({ host: '127.0.0.1', port: srv.address().port, path: route }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { srv.close(); resolve(JSON.parse(raw)); });
      }).on('error', (e) => { srv.close(); reject(e); });
    });
  });
}

test('the real endpoints: capabilities are drawable and the engine is named', async () => {
  const app = express();
  require('../social').attach(app, {});
  const capsRes = await call(app, '/api/social/capabilities');
  assert.equal(capsRes.source, 'engine');
  assert.ok(api.usableManifest(capsRes.capabilities), 'the endpoint must return a list the screen can draw');
  const status = await call(app, '/api/social/status');
  assert.equal(status.engine.provider, 'x-lite');
  assert.equal(status.engine.reachable, true);
  assert.equal(status.engine.health.provider, 'x-lite');
});
