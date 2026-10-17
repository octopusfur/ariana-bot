// tests/x-login.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The X sign-in (social/x_login.js), tested against a scripted fake of X's onboarding flow.
// What these pin, because they are exactly what a naive implementation gets wrong:
//
//   · the flow starts with ?flow_name=login and a guest token;
//   · cookies set in EARLY steps (att, gt) are sent back in LATER steps (Node's fetch has no jar);
//   · 2FA is answered from the TOTP secret (RFC 6238), or handed to a human when there is none;
//   · "enter the code we emailed" waits for a human; "confirm your email" is answered by itself;
//   · a refusal, a captcha-style unknown step, an HTTP error and a missing session each fail with
//     their own code and a message a person can act on.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { XLogin, XLoginError, totp, base32Decode, solveUiMetrics } = require('../social/x_login');
const { makeFakeX } = require('./helpers/fake-x');

const creds = { username: 'ariana_x', password: 'pw', email: 'ariana@example.com' };
const login = (fake, extra = {}) => new XLogin({ ...creds, fetch: fake.fetch, ...extra });

test('happy path: signs in and returns the session cookies and the user id', async () => {
  const fake = makeFakeX();
  const out = await login(fake).run();
  assert.equal(out.status, 'ok');
  assert.equal(out.cookies.auth_token, 'AT123');
  assert.equal(out.cookies.ct0, 'CT456');
  assert.equal(out.userId, '12345');
  assert.deepStrictEqual(fake.ids(), [
    'LoginJsInstrumentationSubtask', 'LoginEnterUserIdentifierSSO', 'LoginEnterPassword', 'AccountDuplicationCheck',
  ]);
});

test('the flow starts with flow_name=login and a guest token', async () => {
  const fake = makeFakeX();
  await login(fake).run();
  const first = fake.requests.find((r) => r.path.endsWith('/onboarding/task.json'));
  assert.equal(first.query.flow_name, 'login');
  assert.equal(first.headers['x-guest-token'], 'guest-1');
  assert.match(first.headers.authorization, /^Bearer /);
  assert.ok(fake.requests.some((r) => r.path.endsWith('/sso_init.json')), 'the sso_init step happens');
});

test('cookies from early steps are sent back on later steps (there is no automatic jar)', async () => {
  const fake = makeFakeX();
  await login(fake).run();
  const pw = fake.requests.find((r) => r.body && r.body.subtask_inputs && r.body.subtask_inputs[0].subtask_id === 'LoginEnterPassword');
  assert.match(pw.headers.cookie, /att=ATT-1/);
  assert.match(pw.headers.cookie, /gt=guest-1/);
  // …but x.com cookies are never sent to another site
  const ui = fake.requests.find((r) => r.host === 'twitter.com');
  assert.ok(!ui.headers.cookie, 'no cookies go to twitter.com');
});

test('the transaction id signer is used when given, and a failing signer never breaks sign-in', async () => {
  const fake = makeFakeX();
  await login(fake, { sign: async () => 'TXID' }).run();
  assert.ok(fake.requests.filter((r) => r.path.endsWith('/task.json')).every((r) => r.headers['x-client-transaction-id'] === 'TXID'));
  const fake2 = makeFakeX();
  const out = await login(fake2, { sign: async () => { throw new Error('boom'); } }).run();
  assert.equal(out.status, 'ok');
});

test('2FA: answered automatically from the TOTP secret', async () => {
  const fake = makeFakeX({ mode: 'totp' });
  const out = await login(fake, { totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }).run();
  assert.equal(out.status, 'ok');
  assert.ok(fake.ids().includes('LoginTwoFactorAuthChallenge'));
});

test('2FA without a secret waits for a person, who then supplies the code', async () => {
  const fake = makeFakeX({ mode: 'totp' });
  const l = login(fake);
  const first = await l.run();
  assert.equal(first.status, 'code_required');
  assert.equal(first.kind, 'totp');
  assert.match(first.prompt, /authenticator/i);
  const out = await l.submitCode(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  assert.equal(out.status, 'ok');
});

test('"we emailed you a code" waits for a person; a wrong code asks again instead of crashing', async () => {
  const fake = makeFakeX({ mode: 'email_code' });
  const l = login(fake);
  const first = await l.run();
  assert.equal(first.status, 'code_required');
  assert.equal(first.kind, 'email_code');
  const wrong = await l.submitCode('000000');
  assert.equal(wrong.status, 'code_required', 'a wrong code is asked for again');
  const out = await l.submitCode(' 424 242 ');
  assert.equal(out.status, 'ok', 'spaces in the code are ignored');
});

test('"confirm your email" is answered with the configured email, no human needed', async () => {
  const fake = makeFakeX({ mode: 'identity' });
  const out = await login(fake).run();
  assert.equal(out.status, 'ok');
  const acid = fake.requests.find((r) => r.body && r.body.subtask_inputs && r.body.subtask_inputs[0].subtask_id === 'LoginAcid');
  assert.equal(acid.body.subtask_inputs[0].enter_text.text, 'ariana@example.com');
});

test('an alternate-identifier step is answered with the email', async () => {
  const fake = makeFakeX({ mode: 'alt_identifier' });
  const out = await login(fake).run();
  assert.equal(out.status, 'ok');
  const alt = fake.requests.find((r) => r.body && r.body.subtask_inputs && r.body.subtask_inputs[0].subtask_id === 'LoginEnterAlternateIdentifierSubtask');
  assert.equal(alt.body.subtask_inputs[0].enter_text.text, 'ariana@example.com');
});

test('a refusal from X is reported in X\'s own words', async () => {
  await assert.rejects(() => login(makeFakeX({ mode: 'deny' })).run(), (e) => e instanceof XLoginError && e.code === 'denied' && /suspended/.test(e.message));
  await assert.rejects(() => new XLogin({ ...creds, password: 'wrong', fetch: makeFakeX().fetch }).run(), (e) => e.code === 'denied' && /Wrong password/.test(e.message));
});

test('an unknown step (captcha and the like) fails loudly and says what to do', async () => {
  await assert.rejects(() => login(makeFakeX({ mode: 'captcha' })).run(), (e) => e.code === 'unexpected_step' && e.subtask === 'ArkoseLogin' && /normal browser/.test(e.message));
});

test('an HTTP error from a step names the step and the status', async () => {
  await assert.rejects(() => login(makeFakeX({ mode: 'http_error' })).run(), (e) => e.code === 'http_error' && e.status === 401 && /LoginEnterUserIdentifierSSO/.test(e.message));
});

test('finishing without a session is an error, never a fake success', async () => {
  await assert.rejects(() => login(makeFakeX({ mode: 'no_cookies' })).run(), (e) => e.code === 'no_cookies');
});

test('missing credentials are refused before any request is made', async () => {
  const fake = makeFakeX();
  await assert.rejects(() => new XLogin({ username: 'a', password: '', fetch: fake.fetch }).run(), (e) => e.code === 'no_credentials');
  assert.equal(fake.requests.length, 0);
});

test('a network failure is a clear error', async () => {
  const l = new XLogin({ ...creds, fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => l.run(), (e) => e.code === 'network' && /ECONNRESET/.test(e.message));
});

test('submitCode with nothing pending, or an empty code, is refused', async () => {
  const l = login(makeFakeX());
  await assert.rejects(() => l.submitCode('123456'), (e) => e.code === 'no_pending');
  const l2 = login(makeFakeX({ mode: 'email_code' }));
  await l2.run();
  await assert.rejects(() => l2.submitCode('  '), (e) => e.code === 'bad_code');
});

test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(totp(secret, 59000), '287082');
  assert.equal(totp(secret, 1111111109000), '081804');
  assert.equal(totp(secret, 1234567890000), '005924');
  assert.deepStrictEqual([...base32Decode('GEZDGNBV')], [...Buffer.from('12345')]);
  assert.equal(totp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 59000), '287082', 'spaces, dashes and case in the secret are tolerated');
});

test('ui_metrics: a solvable script yields its answer; garbage throws (the caller falls back to empty)', () => {
  assert.equal(solveUiMetrics(`function abc() { return "{'k':1}"; }`), '{"k":1}');
  assert.throws(() => solveUiMetrics('not a script'));
});

test('a 403 on the first step is retried once through x.com\'s web path, and the rest of the flow stays there', async () => {
  const fake = makeFakeX();
  const inner = fake.fetch;
  let refused = 0;
  const fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.hostname === 'api.x.com' && u.pathname.endsWith('/onboarding/task.json')) { refused++; return new Response('<html>blocked</html>', { status: 403 }); }
    return inner(url, opts);
  };
  const out = await new XLogin({ ...creds, fetch }).run();
  assert.equal(out.status, 'ok');
  assert.equal(refused, 1, 'api.x.com is tried once, not once per step');
});

test('when both paths refuse, the error says it is the server\'s address being refused', async () => {
  const fake = makeFakeX();
  const inner = fake.fetch;
  const fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/onboarding/task.json')) return new Response('<html>blocked</html>', { status: 403 });
    return inner(url, opts);
  };
  await assert.rejects(() => new XLogin({ ...creds, fetch }).run(), (e) => {
    assert.equal(e.code, 'http_error');
    assert.equal(e.blocked, true);
    assert.match(e.message, /HTTP 403/);
    assert.match(e.message, /network address/);
    return true;
  });
});
