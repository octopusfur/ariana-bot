// social/x_login.js
// ─────────────────────────────────────────────────────────────────────────────
// Signs in to X with username + password, in plain HTTP (no browser, no Chromium).
// It follows the same multi-step "onboarding/task.json" flow the x.com login page uses, ported from
// twikit's long-running login (flow_name=login, sso_init, ui_metrics, a cookie jar carried across
// steps, TOTP 2FA). Every step is data-driven, so an unexpected step fails loudly instead of guessing.
//
//   new XLogin({ username, password, email, totpSecret }).run()
//     → { status: 'ok', cookies, userId }
//     → { status: 'code_required', kind: 'email_code' | 'totp', prompt }   then  .submitCode(code)
//   throws XLoginError(code, message) for everything else.
//
// The password is only ever read from the server's environment (never from the dashboard).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const vm = require('vm');

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const API = 'https://api.x.com/1.1';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

class XLoginError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'XLoginError'; this.code = code; Object.assign(this, extra); }
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──────────────────────────────────
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

// ── cookie jar (Node's fetch keeps none, and the login flow needs the early cookies back) ───────
class Jar {
  constructor() { this.m = new Map(); }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const h of list) {
      const first = h.split(';')[0];
      const eq = first.indexOf('=');
      if (eq < 1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      const expired = /max-age=0/i.test(h) || /expires=thu, 01 jan 1970/i.test(h);
      if (expired || value === '') this.m.delete(name); else this.m.set(name, value);
    }
  }
  header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(n) { return this.m.get(n); }
  toObject() { return Object.fromEntries(this.m); }
}

// ── ui_metrics: a small obfuscated script X serves; the login flow wants its result ─────────────
// Best effort. If it cannot be solved the flow still runs with an empty answer.
function solveUiMetrics(source) {
  const m = /function [a-zA-Z]+\(\) ({.+})/s.exec(source);
  if (!m) throw new Error('no function found');
  const inner = m[1].replace(/(![a-zA-Z]{5}\|\|[a-zA-Z]{5})==([a-zA-Z]{5})/g, '$1===$2');
  const elements = [];
  const mk = (tag) => {
    const el = { tagName: tag, parentNode: null,
      appendChild(c) { c.parentNode = el; }, removeChild(c) { const i = elements.indexOf(c); if (i >= 0) elements.splice(i, 1); },
      remove() { const i = elements.indexOf(el); if (i >= 0) elements.splice(i, 1); }, setAttribute() {},
      get children() { return elements.filter((x) => x.parentNode === el); },
      get lastElementChild() { const c = el.children; return c[c.length - 1]; } };
    elements.push(el); return el;
  };
  const document = { createElement: mk, getElementsByTagName: (t) => elements.filter((e) => e.tagName === t) };
  mk('body');
  const ctx = vm.createContext({ document });
  vm.runInContext('function main()' + inner, ctx, { timeout: 2000 });
  return String(vm.runInContext('main()', ctx, { timeout: 2000 })).replace(/'/g, '"');
}

const SUBTASK_VERSIONS = {
  action_list: 2, alert_dialog: 1, app_download_cta: 1, check_logged_in_account: 1, choice_selection: 3,
  contacts_live_sync_permission_prompt: 0, cta: 7, email_verification: 2, end_flow: 1, enter_date: 1, enter_email: 2,
  enter_password: 5, enter_phone: 2, enter_recaptcha: 1, enter_text: 5, enter_username: 2, generic_urt: 3,
  in_app_notification: 1, interest_picker: 3, js_instrumentation: 1, menu_dialog: 1, notifications_permission_prompt: 2,
  open_account: 2, open_home_timeline: 1, open_link: 1, phone_verification: 4, privacy_options: 1, security_key: 3,
  select_avatar: 4, select_banner: 2, settings_list: 7, show_code: 1, sign_up: 2, sign_up_review: 4,
  tweet_selection_urt: 1, update_users: 1, upload_media: 1, user_recommendations_list: 4, user_recommendations_urt: 1,
  wait_spinner: 3, web_modal: 1,
};

function findFirst(obj, key) {
  if (obj && typeof obj === 'object') {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const v of Object.values(obj)) { const r = findFirst(v, key); if (r !== undefined) return r; }
  }
  return undefined;
}

class XLogin {
  // opts: { username, password, email?, totpSecret?, userAgent?, fetch?, sign? }
  //   fetch: injectable for tests.   sign(method, url) → Promise<string|null> for x-client-transaction-id.
  constructor(opts) {
    this.o = opts;
    this.fetch = opts.fetch || globalThis.fetch;
    this.ua = opts.userAgent || DEFAULT_UA;
    this.jar = new Jar();
    this.guest = null;
    this.flowToken = null;
    this.response = null;
    this.pending = null;
  }

  async call(method, url, { json, params } = {}) {
    const u = new URL(url);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const headers = {
      authorization: `Bearer ${BEARER}`, 'user-agent': this.ua, accept: '*/*', 'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json', 'x-twitter-active-user': 'yes', 'x-twitter-client-language': 'en',
      referer: 'https://x.com/',
    };
    if (this.guest) headers['x-guest-token'] = this.guest;
    const cookie = this.jar.header();
    if (cookie && /(^|\.)x\.com$/.test(u.hostname)) headers.cookie = cookie;
    if (this.o.sign) { try { const id = await this.o.sign(method, u.toString()); if (id) headers['x-client-transaction-id'] = id; } catch (_) {} }
    let res;
    try {
      res = await this.fetch(u.toString(), { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(30000) });
    } catch (e) { throw new XLoginError('network', `Could not reach X (${e.message}).`); }
    if (/(^|\.)x\.com$/.test(u.hostname)) this.jar.absorb(res);
    return res;
  }

  async task(subtaskInputs, { params, data } = {}) {
    const body = { ...(data || {}) };
    if (this.flowToken) body.flow_token = this.flowToken;
    if (subtaskInputs) body.subtask_inputs = subtaskInputs;
    const res = await this.call('POST', `${API}/onboarding/task.json`, { json: body, params });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      const msg = j && j.errors && j.errors[0] && j.errors[0].message;
      const id = subtaskInputs && subtaskInputs[0] && subtaskInputs[0].subtask_id;
      throw new XLoginError('http_error', `X rejected the sign-in step${id ? ' "' + id + '"' : ''} (HTTP ${res.status}${msg ? ': ' + msg : ''}).`, { status: res.status });
    }
    if (!j) throw new XLoginError('bad_response', 'X answered the sign-in step with something that is not JSON.');
    this.response = j;
    this.flowToken = j.flow_token || this.flowToken;
    return j;
  }

  get taskId() { const s = this.response && this.response.subtasks; return s && s.length ? s[0].subtask_id : null; }
  get prompt() { const t = findFirst(this.response, 'secondary_text'); return (t && t.text) || (findFirst(this.response && this.response.subtasks, 'primary_text') || {}).text || ''; }

  deny() {
    const t = findFirst(this.response, 'secondary_text');
    throw new XLoginError('denied', (t && t.text) || 'X refused this sign-in (the account may be locked, or the credentials are wrong).');
  }

  async run() {
    const { username, password } = this.o;
    if (!username || !password) throw new XLoginError('no_credentials', 'Missing X username or password.');

    const g = await this.call('POST', `${API}/guest/activate.json`, { json: {} });
    const gj = await g.json().catch(() => null);
    if (!g.ok || !gj || !gj.guest_token) throw new XLoginError('http_error', `X would not hand out a guest token (HTTP ${g.status}).`, { status: g.status });
    this.guest = gj.guest_token;

    await this.task(null, {
      params: { flow_name: 'login' },
      data: { input_flow_data: { flow_context: { debug_overrides: {}, start_location: { location: 'splash_screen' } } }, subtask_versions: SUBTASK_VERSIONS },
    });
    await this.call('POST', `${API}/onboarding/sso_init.json`, { json: { provider: 'apple' } }).catch(() => {});

    let ui = '';
    try {
      const r = await this.call('GET', 'https://twitter.com/i/js_inst', { params: { c_name: 'ui_metrics' } });
      ui = solveUiMetrics(await r.text());
    } catch (_) { ui = ''; }
    await this.task([{ subtask_id: 'LoginJsInstrumentationSubtask', js_instrumentation: { response: ui, link: 'next_link' } }]);

    await this.task([{ subtask_id: 'LoginEnterUserIdentifierSSO', settings_list: { setting_responses: [{ key: 'user_identifier', response_data: { text_data: { result: username } } }], link: 'next_link' } }]);
    if (this.taskId === 'LoginEnterAlternateIdentifierSubtask') {
      const alt = this.o.email || username;
      await this.task([{ subtask_id: 'LoginEnterAlternateIdentifierSubtask', enter_text: { text: alt, link: 'next_link' } }]);
    }
    if (this.taskId === 'DenyLoginSubtask') this.deny();

    await this.task([{ subtask_id: 'LoginEnterPassword', enter_password: { password, link: 'next_link' } }]);
    return this.advance();
  }

  // Walk whatever step X shows next, until we have a session or need a human-supplied code.
  async advance() {
    for (let i = 0; i < 8; i++) {
      const id = this.taskId;
      if (id === 'DenyLoginSubtask') this.deny();
      if (id === 'AccountDuplicationCheck') {
        await this.task([{ subtask_id: id, check_logged_in_account: { link: 'AccountDuplicationCheck_false' } }]);
        continue;
      }
      if (id === 'LoginAcid') {
        const prompt = this.prompt;
        if (/code/i.test(prompt)) { this.pending = { subtask: id, kind: 'email_code', prompt }; return { status: 'code_required', kind: 'email_code', prompt }; }
        const ans = this.o.email || this.o.username; // "confirm your email / phone / username"
        await this.task([{ subtask_id: id, enter_text: { text: ans, link: 'next_link' } }]);
        continue;
      }
      if (id === 'LoginTwoFactorAuthChallenge') {
        if (this.o.totpSecret) {
          await this.task([{ subtask_id: id, enter_text: { text: totp(this.o.totpSecret), link: 'next_link' } }]);
          continue;
        }
        const prompt = this.prompt;
        this.pending = { subtask: id, kind: 'totp', prompt };
        return { status: 'code_required', kind: 'totp', prompt };
      }
      if (id && id !== 'LoginSuccessSubtask') {
        throw new XLoginError('unexpected_step', `X asked for an unexpected step ("${id}"). That is usually a captcha or a security check; sign in to this account once from a normal browser and approve it, then try again.`, { subtask: id });
      }
      break; // no subtasks left (or LoginSuccessSubtask) = flow finished
    }
    const cookies = this.jar.toObject();
    if (!cookies.auth_token || !cookies.ct0) {
      throw new XLoginError('no_cookies', 'The sign-in finished but X did not issue a session (it may want a captcha). Try again later, or sign in once from a normal browser first.');
    }
    const twid = decodeURIComponent(cookies.twid || '');
    const m = /(\d{5,})/.exec(twid) || /(\d{5,})/.exec(String(findFirst(this.response, 'id_str') || ''));
    return { status: 'ok', cookies, userId: m ? m[1] : null };
  }

  async submitCode(code) {
    if (!this.pending) throw new XLoginError('no_pending', 'There is no sign-in waiting for a code.');
    const clean = String(code || '').replace(/\s+/g, '');
    if (!clean) throw new XLoginError('bad_code', 'Enter the code first.');
    const { subtask } = this.pending;
    this.pending = null;
    await this.task([{ subtask_id: subtask, enter_text: { text: clean, link: 'next_link' } }]);
    return this.advance();
  }
}

module.exports = { XLogin, XLoginError, totp, base32Decode, solveUiMetrics, Jar };
