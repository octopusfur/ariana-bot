// tests/social-screen.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The Social screen must never come up blank, and must always let you add and
// sign in an account.
//
// What went wrong: with the Browser Use engine connected, the capabilities
// endpoint handed the dashboard a bare list of site names. The dashboard called
// `.supported.map(...)` on each, threw, and everything under the engine card
// (accounts, activity, autonomy) stayed empty — so there was nowhere to add or
// sign in an account. These tests run the REAL dashboard code from
// public/index.html against the payloads each engine really sends.
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
delete process.env.SOCIAL_ENGINE_URL;
delete process.env.SOCIAL_ENGINE_API_KEY;
process.env.BROWSER_USE_API_KEY = 'bu_test';

const express = require('express');
const bu = require('../social/browseruse_engine');
const api = require('../social/api');

const realFetch = global.fetch;
test.after(() => { global.fetch = realFetch; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// ── THE REAL DASHBOARD CODE, IN A SANDBOX ───────────────────────────────────

function loadScreen() {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('let soc={'));
  const endFn = lines.findIndex((l) => l.startsWith('async function socConfirmAction'));
  assert.ok(start > 0 && endFn > start, 'the Social block moved — update this test');
  let end = endFn; while (end < lines.length && !/^}/.test(lines[end])) end++; // closing brace of socConfirmAction
  const code = lines.slice(start, end + 1).join('\n');

  const els = {};
  const el = (id) => els[id] || (els[id] = { innerHTML: '', style: {} });
  const toasts = [];
  const opened = [];
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    escHTML: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    plainErr: (s) => s, authH: () => ({}), toast: (m) => toasts.push(m),
    window: { open: (u) => opened.push(u) }, console: { error() {}, log() {} },
    fetch: async () => ({ json: async () => ({}) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(code + ';this.soc=soc;this.renderSocial=renderSocial;this.socConnect=socConnect;this.socPost=socPost;', sandbox);
  return { sandbox, els, toasts, opened };
}

const connectedBU = {
  engine: { configured: true, reachable: true, health: { provider: 'browser-use', engine: 'browser-use-cloud', billing: { credits: 4.2 } } },
  storage: { supabase: true },
};
const described = (ids) => ({ capabilities: { platforms: ids.map((id) => ({ id, label: id, handle_label: 'handle', supported: [{ action: 'dm' }], unsupported: [{ action: 'search', reason: 'not possible' }] })) } });

function draw(status, caps, accounts = []) {
  const { sandbox, els, toasts, opened } = loadScreen();
  sandbox.soc.status = status; sandbox.soc.caps = caps; sandbox.soc.accounts = accounts; sandbox.soc.activity = [];
  sandbox.renderSocial();
  return { sandbox, els, toasts, opened, accountsHtml: els['social-accounts'].innerHTML, strip: els['social-engine'].innerHTML };
}
const addRows = (html) => (html.match(/socAdd\('(\w+)'\)/g) || []).map((x) => x.slice(8, -2));

// ── THE BUG ─────────────────────────────────────────────────────────────────

test('the exact payload that blanked the screen now draws the account rows', () => {
  // what social/browseruse_engine.js used to return: a bare list of site names
  const { accountsHtml } = draw(connectedBU, { capabilities: { provider: 'browser-use-cloud', platforms: ['instagram', 'linkedin', 'twitter'] } });
  assert.deepStrictEqual(addRows(accountsHtml), ['instagram', 'linkedin', 'twitter'], 'you can add an X account even when the list is malformed');
});

test('every malformed capability shape still leaves the Add rows in place', () => {
  for (const [label, caps] of [
    ['missing', null],
    ['empty object', { capabilities: {} }],
    ['keyed object, not a list', { capabilities: { platforms: { instagram: {} } } }],
    ['empty list', { capabilities: { platforms: [] } }],
    ['list of junk', { capabilities: { platforms: [null, 7, 'x', {}] } }],
  ]) {
    const { accountsHtml } = draw(connectedBU, caps);
    assert.deepStrictEqual(addRows(accountsHtml), ['instagram', 'linkedin', 'twitter'], label);
  }
});

test('a good capability list is used as sent', () => {
  const { accountsHtml } = draw(connectedBU, described(['twitter']));
  assert.deepStrictEqual(addRows(accountsHtml), ['twitter']);
  assert.match(accountsHtml, /<b>Can:<\/b> dm/);
  assert.match(accountsHtml, /Why not/);
});

test('one section failing never blanks the others', () => {
  const { sandbox, els } = loadScreen();
  sandbox.soc.status = connectedBU; sandbox.soc.caps = described(['twitter']);
  sandbox.soc.activity = [{ get status() { throw new Error('boom'); } }]; // breaks the activity list only
  sandbox.renderSocial();
  assert.match(els['social-engine'].innerHTML, /Engine connected/);
  assert.deepStrictEqual(addRows(els['social-accounts'].innerHTML), ['twitter']);
  assert.match(els['social-activity'].innerHTML, /Could not draw this part/);
  assert.ok(els['social-autonomy'].innerHTML !== undefined);
});

test('the engine card says what the engine really is, not "0 browsers open"', () => {
  const { strip } = draw(connectedBU, described(['twitter']));
  const text = strip.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /browser-use · \$4\.20 credit · state in Supabase/);
  assert.ok(!/0 browser\(s\) open/.test(text));
  // an engine that does report browsers still shows them
  const sc = draw({ engine: { configured: true, reachable: true, health: { provider: 'socialcrabs', browsers_open: 2 } }, storage: {} }, described(['twitter']));
  assert.match(sc.strip, /socialcrabs · 2 browser\(s\) open · state in local files/);
});

// ── SIGNING IN ──────────────────────────────────────────────────────────────

test('sign-in: a visible link stays on the account, so a blocked popup cannot strand you', async () => {
  const account = { account_id: 'twitter:ariana', platform: 'twitter', handle: 'ariana', status: 'not_connected', actions_enabled: false, capabilities: { supported: [], unsupported: [] } };
  const { sandbox, els, toasts, opened } = loadScreen();
  sandbox.soc.status = connectedBU; sandbox.soc.caps = described(['twitter']); sandbox.soc.accounts = [account]; sandbox.soc.activity = [];
  sandbox.socPost = async () => ({ ok: true, login_url: 'https://live.browser-use.com/session/abc' });
  vm.runInContext('socPost = this.socPost', sandbox);
  await sandbox.socConnect('twitter:ariana');
  sandbox.renderSocial();
  assert.deepStrictEqual(opened, ['https://live.browser-use.com/session/abc'], 'it still tries to open it');
  assert.match(els['social-accounts'].innerHTML, /href="https:\/\/live\.browser-use\.com\/session\/abc"[^>]*>Open the sign-in browser/);
  assert.match(toasts.join(' '), /If it did not open/);
});

test('sign-in: a login link that is not https is never opened or shown', async () => {
  const { sandbox, els, opened } = loadScreen();
  const account = { account_id: 'twitter:ariana', platform: 'twitter', handle: 'ariana', status: 'not_connected', capabilities: { supported: [], unsupported: [] } };
  sandbox.soc.status = connectedBU; sandbox.soc.caps = described(['twitter']); sandbox.soc.accounts = [account]; sandbox.soc.activity = [];
  sandbox.socPost = async () => ({ ok: true, login_url: 'javascript:alert(1)' });
  vm.runInContext('socPost = this.socPost', sandbox);
  await sandbox.socConnect('twitter:ariana');
  sandbox.renderSocial();
  assert.deepStrictEqual(opened, []);
  assert.ok(!/javascript:/.test(els['social-accounts'].innerHTML));
});

test('sign-in: once connected the link goes away', async () => {
  const { sandbox, els } = loadScreen();
  const account = { account_id: 'twitter:ariana', platform: 'twitter', handle: 'ariana', status: 'not_connected', capabilities: { supported: [], unsupported: [] } };
  sandbox.soc.status = connectedBU; sandbox.soc.caps = described(['twitter']); sandbox.soc.accounts = [account]; sandbox.soc.activity = [];
  sandbox.soc.login['twitter:ariana'] = 'https://live.browser-use.com/session/abc';
  sandbox.socPost = async () => ({ ok: true, connected: true });
  vm.runInContext('socPost = this.socPost', sandbox);
  await sandbox.socConnect('twitter:ariana');
  assert.equal(sandbox.soc.login['twitter:ariana'], undefined);
  sandbox.soc.accounts = [{ ...account, status: 'online' }];
  sandbox.renderSocial();
  assert.ok(!/Open the sign-in browser/.test(els['social-accounts'].innerHTML));
});

// ── THE ENGINE SIDE ─────────────────────────────────────────────────────────

test('Browser Use answers in the shape the dashboard draws, and names itself', async () => {
  const caps = (await bu.capabilities()).capabilities;
  assert.ok(api.usableManifest(caps));
  assert.deepStrictEqual(caps.platforms.map((p) => p.id).sort(), ['instagram', 'linkedin', 'tiktok', 'twitter']); // TikTok is offered while Browser Use is the engine
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ totalCreditsBalanceUsd: 4.2, concurrentSessionLimit: 3 }) });
  const h = await bu.health();
  assert.equal(h.health.provider, 'browser-use');
  assert.equal(h.health.billing.credits, 4.2);
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

test('the real endpoint: with Browser Use connected, capabilities are drawable and the engine is named', async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ totalCreditsBalanceUsd: 1 }) });
  const app = express();
  require('../social').attach(app, {});
  const capsRes = await call(app, '/api/social/capabilities');
  assert.ok(api.usableManifest(capsRes.capabilities), 'the endpoint must return a list the screen can draw');
  const status = await call(app, '/api/social/status');
  assert.equal(status.engine.provider, 'browser-use');
  assert.equal(status.engine.health.provider, 'browser-use');
});

test('the real endpoint: an engine that sends an undrawable list gets the bundled one instead', async () => {
  delete process.env.BROWSER_USE_API_KEY;
  process.env.SOCIAL_ENGINE_URL = 'https://engine.test'; process.env.SOCIAL_ENGINE_API_KEY = 'k';
  global.fetch = async (url) => {
    const body = String(url).endsWith('/api/capabilities') ? { platforms: { instagram: { label: 'Instagram' } } } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const app = express();
    require('../social').attach(app, {});
    const res = await call(app, '/api/social/capabilities');
    assert.equal(res.source, 'bundled');
    assert.ok(api.usableManifest(res.capabilities));
  } finally {
    delete process.env.SOCIAL_ENGINE_URL; delete process.env.SOCIAL_ENGINE_API_KEY; process.env.BROWSER_USE_API_KEY = 'bu_test';
  }
});
