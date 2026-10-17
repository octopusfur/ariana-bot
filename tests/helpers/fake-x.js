// tests/helpers/fake-x.js
// A scripted stand-in for X's login ("onboarding/task.json") service. It is NOT X: it plays the
// documented sequence of subtasks so the login code can be tested step by step, offline, and it
// records every request so tests can assert what was really sent (cookies, guest token, flow_name…).
'use strict';

const { totp } = require('../../social/x_login');

// mode: ok | totp | email_code | identity | alt_identifier | deny | captcha | http_error | no_cookies
function makeFakeX({ mode = 'ok', password = 'pw', totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', emailCode = '424242', email = 'ariana@example.com' } = {}) {
  const requests = [];
  let stage = 'start';

  const json = (obj, { status = 200, cookies = [] } = {}) => {
    const h = new Headers({ 'content-type': 'application/json' });
    for (const c of cookies) h.append('set-cookie', c);
    return new Response(JSON.stringify(obj), { status, headers: h });
  };
  const task = (id, extra = {}) => ({ flow_token: 'flow-' + id, subtasks: [{ subtask_id: id, ...extra }] });
  const done = () => ({ flow_token: 'flow-done', subtasks: [] });
  const sessionCookies = mode === 'no_cookies' ? [] : ['auth_token=AT123; Path=/; HttpOnly', 'ct0=CT456; Path=/', 'twid="u%3D12345"; Path=/'];

  async function fetch(url, opts = {}) {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = opts.body ? JSON.parse(opts.body) : null;
    const req = { url: u.toString(), host: u.hostname, path: u.pathname, query: Object.fromEntries(u.searchParams), method: opts.method || 'GET', body, headers };
    requests.push(req);

    if (u.pathname.endsWith('/guest/activate.json')) return json({ guest_token: 'guest-1' }, { cookies: ['gt=guest-1; Path=/'] });
    if (u.pathname.endsWith('/sso_init.json')) return json({});
    if (u.hostname === 'twitter.com' && u.pathname === '/i/js_inst') return new Response('not a solvable script', { status: 200 });
    if (!u.pathname.endsWith('/onboarding/task.json')) return json({ errors: [{ message: 'unexpected ' + u.pathname }] }, { status: 404 });

    if (u.searchParams.get('flow_name') === 'login') {
      stage = 'start';
      return json(task('LoginJsInstrumentationSubtask'), { cookies: ['att=ATT-1; Path=/'] });
    }
    const input = body && body.subtask_inputs && body.subtask_inputs[0];
    const id = input && input.subtask_id;
    if (mode === 'http_error' && id === 'LoginEnterUserIdentifierSSO') return json({ errors: [{ message: 'Could not authenticate you' }] }, { status: 401 });

    switch (id) {
      case 'LoginJsInstrumentationSubtask':
        return json(task('LoginEnterUserIdentifierSSO'));
      case 'LoginEnterUserIdentifierSSO':
        return json(mode === 'alt_identifier' ? task('LoginEnterAlternateIdentifierSubtask') : task('LoginEnterPassword'));
      case 'LoginEnterAlternateIdentifierSubtask':
        return json(task('LoginEnterPassword'));
      case 'LoginEnterPassword': {
        if (input.enter_password.password !== password) {
          return json({ flow_token: 'f', subtasks: [{ subtask_id: 'DenyLoginSubtask', cta: { secondary_text: { text: 'Wrong password.' } } }] });
        }
        if (mode === 'deny') return json({ flow_token: 'f', subtasks: [{ subtask_id: 'DenyLoginSubtask', cta: { secondary_text: { text: 'We suspended this account.' } } }] });
        if (mode === 'captcha') return json(task('ArkoseLogin'));
        if (mode === 'totp') return json(task('LoginTwoFactorAuthChallenge', { enter_text: { secondary_text: { text: 'Enter the code from your authenticator app.' } } }));
        if (mode === 'email_code') return json(task('LoginAcid', { enter_text: { secondary_text: { text: 'Check your email for a confirmation code.' } } }));
        if (mode === 'identity') return json(task('LoginAcid', { enter_text: { secondary_text: { text: 'Confirm your email address or phone number.' } } }));
        return json(task('AccountDuplicationCheck'));
      }
      case 'LoginTwoFactorAuthChallenge':
        if (input.enter_text.text === totp(totpSecret)) return json(task('AccountDuplicationCheck'));
        return json(task('LoginTwoFactorAuthChallenge', { enter_text: { secondary_text: { text: 'That code is wrong.' } } }));
      case 'LoginAcid':
        if (mode === 'identity') return input.enter_text.text === email ? json(task('AccountDuplicationCheck')) : json(task('LoginAcid', { enter_text: { secondary_text: { text: 'Confirm your email address.' } } }));
        if (input.enter_text.text === emailCode) return json(task('AccountDuplicationCheck'));
        return json(task('LoginAcid', { enter_text: { secondary_text: { text: 'Wrong code. Check your email for a confirmation code.' } } }));
      case 'AccountDuplicationCheck':
        return json(done(), { cookies: sessionCookies });
      default:
        return json({ errors: [{ message: 'unknown subtask ' + id }] }, { status: 400 });
    }
  }
  return { fetch, requests, ids: () => requests.map((r) => r.body && r.body.subtask_inputs && r.body.subtask_inputs[0] && r.body.subtask_inputs[0].subtask_id).filter(Boolean) };
}

module.exports = { makeFakeX };
