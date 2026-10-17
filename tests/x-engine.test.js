// tests/x-engine.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's built-in X engine (social/x_engine.js + session_vault.js), offline:
//
//   · sessions are ENCRYPTED at rest, bound to their account, and survive a "restart";
//   · Connect verifies a saved login first, signs in only when it has to, and asks a human only
//     when X demands a code;
//   · when X expires a session mid-action she signs in again by herself ONCE, and does not hammer
//     X with repeated logins;
//   · every action reaches the right client call with the right arguments, and every failure
//     comes back as a code a person can act on;
//   · actions run one at a time.
// The vendored HTTP client is replaced by a fake that records calls; X's login is the scripted
// fake from tests/helpers/fake-x.js.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-x-engine-'));
process.env.SOCIAL_DATA_DIR = TMP;
process.env.X_SESSION_KEY = 'test-session-key';
process.env.SOCIAL_ACTION_GAP_MS = '0';
process.env.X_RELOGIN_MIN_MINUTES = '0';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const k of ['X_PASSWORD', 'X_USERNAME', 'X_EMAIL', 'X_TOTP_SECRET', 'X_CREDENTIALS']) delete process.env[k];

const accounts = require('../social/accounts');
const vault = require('../social/session_vault');
const xengine = require('../social/x_engine');
const { makeFakeX } = require('./helpers/fake-x');

const realFetch = global.fetch;
test.after(() => { global.fetch = realFetch; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// ── a fake of the vendored client library ───────────────────────────────────
class AuthError extends Error { constructor(m = 'auth') { super(m); this.status = 401; } }
class RateLimitError extends Error {}
class NotFoundError extends Error {}
class NetworkError extends Error {}
class ApiError extends Error { constructor(m, status, data) { super(m); this.status = status; this.data = data; } }

let calls = [];
let screenName = 'ariana_x';
let inbox = { conversations: [] };
let failWith = null;      // an Error thrown by the next client call
let busy = 0, maxBusy = 0;

class FakeClient {
  constructor(o) { this.o = o; }
  async rest(p) {
    calls.push({ fn: 'rest', p, cookies: this.o.cookies });
    if (this.o.cookies.includes('auth_token=OLD')) throw new AuthError();
    return { screen_name: screenName };
  }
}
const rec = (fn, ret) => async (c, ...args) => {
  busy++; maxBusy = Math.max(maxBusy, busy);
  await new Promise((r) => setTimeout(r, 5));
  busy--;
  calls.push({ fn, args, cookies: c.o.cookies });
  if (c.o.cookies.includes('auth_token=OLD')) throw new AuthError();
  if (failWith) { const e = failWith; failWith = null; throw e; }
  return typeof ret === 'function' ? ret(...args) : ret;
};
const fakeLib = () => ({
  TwitterHttpClient: FakeClient,
  postTweet: rec('postTweet', { id: '900' }),
  replyToTweet: rec('replyToTweet', { id: '901' }),
  likeTweet: rec('likeTweet', { success: true }),
  retweet: rec('retweet', { success: true }),
  followByUsername: rec('followByUsername', { success: true }),
  unfollowUser: rec('unfollowUser', { success: true }),
  sendDMByUsername: rec('sendDMByUsername', { messageId: 'm1' }),
  getInbox: rec('getInbox', () => inbox),
  scrapeProfile: rec('scrapeProfile', (u) => ({ id: '777', name: 'Bob', username: u, bio: 'hi', followers: 10, following: 5, tweetCount: 42, verified: false })),
  REST: { verifyCredentials: '/1.1/account/verify_credentials.json' },
  USER_AGENTS: ['TestUA/1.0'],
  errors: { AuthError, RateLimitError, NotFoundError, NetworkError },
  getTransactionId: async () => null,
});

let account;
async function reset({ creds = true, seed = null } = {}) {
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) { try { fs.rmSync(path.join(TMP, f)); } catch (_) {} }
  fs.rmSync(path.join(TMP, 'secrets'), { recursive: true, force: true });
  accounts.invalidate();
  xengine._reset();
  xengine._setLibForTest(fakeLib());
  calls = []; screenName = 'ariana_x'; inbox = { conversations: [] }; failWith = null; busy = 0; maxBusy = 0;
  process.env.X_RELOGIN_MIN_MINUTES = '0';
  for (const k of ['X_PASSWORD', 'X_USERNAME', 'X_EMAIL', 'X_TOTP_SECRET', 'X_CREDENTIALS']) delete process.env[k];
  if (creds) { process.env.X_PASSWORD = 'pw'; process.env.X_EMAIL = 'ariana@example.com'; }
  const r = await accounts.add({ platform: 'twitter', handle: 'ariana_x' });
  account = await accounts.get(r.account.account_id);
  if (seed) await vault.save(account.account_id, seed);
  global.fetch = realFetch;
}
const seedGood = { cookies: { auth_token: 'GOOD', ct0: 'c' }, user_agent: 'TestUA/1.0', user_id: '555' };
const seedOld = { cookies: { auth_token: 'OLD', ct0: 'c' }, user_agent: 'TestUA/1.0', user_id: '555' };

// ── the vault ───────────────────────────────────────────────────────────────

test('vault: a session is encrypted at rest, bound to its account, and unreadable with another key', async () => {
  await reset();
  const saved = await vault.save('twitter:ariana_x', { cookies: { auth_token: 'SECRET-TOKEN-VALUE' } });
  assert.equal(saved.ok, true);
  const raw = fs.readdirSync(path.join(TMP, 'secrets')).map((f) => fs.readFileSync(path.join(TMP, 'secrets', f), 'utf8')).join('');
  assert.ok(!raw.includes('SECRET-TOKEN-VALUE') && !raw.includes('auth_token'), 'no plaintext on disk');
  assert.equal((await vault.load('twitter:ariana_x')).session.cookies.auth_token, 'SECRET-TOKEN-VALUE');

  // copy the blob to another account's slot: it must not decrypt there
  const store = require('../social/store');
  await store.saveSecret('xsession:twitter:someone_else', await store.loadSecret('xsession:twitter:ariana_x'));
  const moved = await vault.load('twitter:someone_else');
  assert.equal(moved.ok, false);
  assert.equal(moved.code, 'unreadable');

  process.env.X_SESSION_KEY = 'a-different-key';
  const wrong = await vault.load('twitter:ariana_x');
  process.env.X_SESSION_KEY = 'test-session-key';
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /sign in again/i);
});

test('vault: with no key at all it refuses to store, and says how to fix it', async () => {
  const keep = process.env.X_SESSION_KEY; delete process.env.X_SESSION_KEY;
  try {
    const r = await vault.save('twitter:a', { cookies: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_key');
    assert.match(r.error, /X_SESSION_KEY/);
  } finally { process.env.X_SESSION_KEY = keep; }
});

test('vault: without X_SESSION_KEY the key is derived from the Supabase service key', async () => {
  const keep = process.env.X_SESSION_KEY; delete process.env.X_SESSION_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-abc';
  try {
    assert.equal((await vault.save('twitter:derived', { cookies: { a: 'b' } })).ok, true);
    assert.equal((await vault.load('twitter:derived')).session.cookies.a, 'b');
  } finally { delete process.env.SUPABASE_SERVICE_ROLE_KEY; process.env.X_SESSION_KEY = keep; await vault.remove('twitter:derived'); }
});

// ── credentials ─────────────────────────────────────────────────────────────

test('credentials come only from the server environment, per account or as a single login', async () => {
  await reset({ creds: false });
  assert.equal(xengine.credsFor(account), null);
  process.env.X_PASSWORD = 'pw1'; process.env.X_EMAIL = 'e@x.com'; process.env.X_TOTP_SECRET = 'SECRET';
  assert.deepStrictEqual(xengine.credsFor(account), { username: 'ariana_x', password: 'pw1', email: 'e@x.com', totpSecret: 'SECRET' });
  process.env.X_USERNAME = 'someone_else';
  assert.equal(xengine.credsFor(account), null, 'a single login is not handed to a different handle');
  process.env.X_CREDENTIALS = JSON.stringify({ Ariana_X: { password: 'pw2', totp: 'T2' } });
  assert.equal(xengine.credsFor(account), null, 'X_CREDENTIALS keys must match the handle (lowercase)');
  process.env.X_CREDENTIALS = JSON.stringify({ ariana_x: { password: 'pw2', totp: 'T2' } });
  assert.deepStrictEqual(xengine.credsFor(account), { username: 'ariana_x', password: 'pw2', email: '', totpSecret: 'T2' });
});

// ── connect ─────────────────────────────────────────────────────────────────

test('connect: no server password → a clear, actionable refusal, and no request to X', async () => {
  await reset({ creds: false });
  let hit = 0; global.fetch = async () => { hit++; return new Response('{}'); };
  const r = await xengine.connect(account);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_credentials');
  assert.match(r.error, /X_PASSWORD/);
  assert.equal(hit, 0);
});

test('connect: signs in, saves the session encrypted, and the saved session then verifies', async () => {
  await reset();
  const fake = makeFakeX({ password: 'pw' });
  global.fetch = fake.fetch;
  const r = await xengine.connect(account);
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.equal(r.stored_in, 'file');
  const s = (await vault.load(account.account_id)).session;
  assert.equal(s.cookies.auth_token, 'AT123');
  assert.equal(s.user_id, '12345');
  assert.equal(s.user_agent, 'TestUA/1.0');

  const v = await xengine.verify(account);
  assert.equal(v.session.connected, true);
  assert.match(v.session.detail, /Signed in as @ariana_x/);
});

test('connect: a saved login that still works is reused — X is not asked to sign in again', async () => {
  await reset({ seed: seedGood });
  const fake = makeFakeX();
  global.fetch = fake.fetch;
  const r = await xengine.connect(account);
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.equal(fake.requests.length, 0, 'no login traffic at all');
});

test('connect: an expired saved login triggers one fresh sign-in', async () => {
  await reset({ seed: seedOld });
  const fake = makeFakeX();
  global.fetch = fake.fetch;
  const r = await xengine.connect(account);
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.equal((await vault.load(account.account_id)).session.cookies.auth_token, 'AT123');
});

test('connect: when X wants an emailed code, it waits; the code finishes it; a wrong code does not lose the sign-in', async () => {
  await reset();
  global.fetch = makeFakeX({ mode: 'email_code' }).fetch;
  const r = await xengine.connect(account);
  assert.equal(r.ok, true);
  assert.equal(r.needs_code, true);
  assert.equal(r.kind, 'email_code');
  assert.equal(xengine.hasPendingLogin(account), true);

  // tapping Connect again does not start a second sign-in
  const again = await xengine.connect(account);
  assert.equal(again.needs_code, true);

  const wrong = await xengine.submitCode(account, '000000');
  assert.equal(wrong.needs_code, true, 'a wrong code asks again');
  const done = await xengine.submitCode(account, '424242');
  assert.equal(done.ok, true);
  assert.equal(done.connected, true);
  assert.equal(xengine.hasPendingLogin(account), false);
  assert.equal((await vault.load(account.account_id)).session.cookies.auth_token, 'AT123');
});

test('connect: a code with nothing pending is refused politely', async () => {
  await reset();
  const r = await xengine.submitCode(account, '123456');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_pending');
});

test('connect: a refusal from X is surfaced with its code, and nothing is saved', async () => {
  await reset();
  global.fetch = makeFakeX({ mode: 'deny' }).fetch;
  const r = await xengine.connect(account);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'denied');
  assert.match(r.error, /suspended/);
  assert.equal((await vault.load(account.account_id)).session, null);
});

test('verify: a session for a different account is not accepted as hers', async () => {
  await reset({ seed: seedGood });
  screenName = 'someone_else';
  const v = await xengine.verify(account);
  assert.equal(v.session.connected, false);
  assert.match(v.session.detail, /@someone_else, not @ariana_x/);
});

test('verify: with no saved login it says so, and does not call X', async () => {
  await reset();
  const v = await xengine.verify(account);
  assert.equal(v.ok, true);
  assert.equal(v.session.connected, false);
  assert.equal(v.session.exists, false);
  assert.equal(calls.length, 0);
});

// ── actions ─────────────────────────────────────────────────────────────────

test('act: every action reaches the right client call with the right arguments', async () => {
  await reset({ seed: seedGood });
  const url = 'https://x.com/bob/status/1234567890';
  const cases = [
    ['like', { url }, 'likeTweet', ['1234567890']],
    ['repost', { url }, 'retweet', ['1234567890']],
    ['comment', { url, text: 'nice' }, 'replyToTweet', ['1234567890', 'nice']],
    ['reply', { url, text: 'nice' }, 'replyToTweet', ['1234567890', 'nice']],
    ['post', { text: 'hello x' }, 'postTweet', ['hello x']],
    ['follow', { username: '@bob' }, 'followByUsername', ['bob']],
    ['dm', { username: 'bob', message: 'hi' }, 'sendDMByUsername', ['bob', 'hi']],
  ];
  for (const [action, payload, fn, args] of cases) {
    calls = [];
    const r = await xengine.act(account, action, payload);
    assert.equal(r.ok, true, `${action}: ${r.error}`);
    assert.equal(r.result.success, true);
    const c = calls.find((x) => x.fn === fn);
    assert.ok(c, `${action} should call ${fn}`);
    assert.deepStrictEqual(c.args, args, action);
    assert.match(c.cookies, /auth_token=GOOD/);
  }
});

test('act: posting and replying hand back the new tweet\'s id and link', async () => {
  await reset({ seed: seedGood });
  const r = await xengine.act(account, 'post', { text: 'hi' });
  assert.equal(r.result.tweet_id, '900');
  assert.equal(r.result.url, 'https://x.com/ariana_x/status/900');
});

test('act: unfollow looks the user up first, then unfollows by id', async () => {
  await reset({ seed: seedGood });
  const r = await xengine.act(account, 'unfollow', { username: 'bob' });
  assert.equal(r.ok, true);
  assert.deepStrictEqual(calls.map((c) => c.fn), ['scrapeProfile', 'unfollowUser']);
  assert.deepStrictEqual(calls[1].args, ['777']);
});

test('act: viewing a profile returns clean, named fields', async () => {
  await reset({ seed: seedGood });
  const r = await xengine.act(account, 'view_profile', { username: 'bob' });
  assert.equal(r.ok, true);
  assert.deepStrictEqual(
    { name: r.result.name, username: r.result.username, bio: r.result.bio, followers: r.result.followers, following: r.result.following, tweets: r.result.tweets },
    { name: 'Bob', username: 'bob', bio: 'hi', followers: 10, following: 5, tweets: 42 },
  );
  assert.equal((await xengine.act(account, 'engagement', { username: 'bob' })).result.followers, 10);
});

test('act: bad input is refused before X is asked, with a reason', async () => {
  await reset({ seed: seedGood });
  for (const [action, payload] of [['like', { url: 'https://x.com/bob' }], ['post', {}], ['dm', { username: 'bob' }], ['follow', {}], ['comment', { url: 'https://x.com/a/status/1' }]]) {
    calls = [];
    const r = await xengine.act(account, action, payload);
    assert.equal(r.ok, false, action);
    assert.equal(r.code, 'bad_input', action);
    assert.equal(calls.length, 0, `${action} must not reach X`);
  }
});

test('act: something the engine cannot do, or a platform it does not support, is refused plainly', async () => {
  await reset({ seed: seedGood });
  assert.equal((await xengine.act(account, 'search', { query: 'x' })).code, 'unsupported');
  assert.equal((await xengine.act({ ...account, platform: 'instagram' }, 'like', {})).code, 'unsupported_platform');
});

test('act: with no saved login it tells her to Connect, and does not guess', async () => {
  await reset();
  const r = await xengine.act(account, 'like', { url: 'https://x.com/a/status/1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_session');
  assert.match(r.error, /Connect/);
});

test('act: X errors become codes a person can act on', async () => {
  await reset({ seed: seedGood });
  const url = 'https://x.com/a/status/1';
  const map = [
    [new RateLimitError('slow'), 'rate_limited'],
    [new NotFoundError('gone'), 'not_found'],
    [new NetworkError('dns'), 'unreachable'],
    [new ApiError('automated', 403, { errors: [{ code: 226 }] }), 'challenge'],
    [new ApiError('locked', 403, { errors: [{ code: 326 }] }), 'challenge'],
    [new ApiError('dup', 400, { errors: [{ code: 187 }] }), 'action_failed'],
  ];
  for (const [err, code] of map) {
    failWith = err;
    const r = await xengine.act(account, 'like', { url });
    assert.equal(r.ok, false);
    assert.equal(r.code, code, err.message);
  }
});

test('act: an expired session is replaced by ONE automatic sign-in, then the action is retried', async () => {
  await reset({ seed: seedOld });
  const fake = makeFakeX();
  global.fetch = fake.fetch;
  const r = await xengine.act(account, 'like', { url: 'https://x.com/a/status/42' });
  assert.equal(r.ok, true, r.error);
  const likes = calls.filter((c) => c.fn === 'likeTweet');
  assert.equal(likes.length, 2, 'first try fails on the old cookies, second succeeds');
  assert.match(likes[0].cookies, /auth_token=OLD/);
  assert.match(likes[1].cookies, /auth_token=AT123/);
  assert.equal(fake.ids().filter((i) => i === 'LoginEnterPassword').length, 1, 'exactly one sign-in');
  assert.equal((await vault.load(account.account_id)).session.cookies.auth_token, 'AT123', 'the new session is saved');
});

test('act: it does not hammer X with sign-ins — a second expiry inside the cool-down just reports it', async () => {
  await reset({ seed: seedOld });
  global.fetch = makeFakeX().fetch;
  process.env.X_RELOGIN_MIN_MINUTES = '10';
  assert.equal((await xengine.act(account, 'like', { url: 'https://x.com/a/status/1' })).ok, true); // first expiry: re-login
  await vault.save(account.account_id, seedOld);                                                       // expires again at once
  const r = await xengine.act(account, 'like', { url: 'https://x.com/a/status/2' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'session_expired');
  assert.match(r.error, /waiting before trying again/);
});

test('act: an expired session with no server password says exactly what is missing', async () => {
  await reset({ creds: false, seed: seedOld });
  const r = await xengine.act(account, 'like', { url: 'https://x.com/a/status/1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /signing in again failed/);
  assert.match(r.error, /X_PASSWORD/);
});

test('act: an expired session where X now wants a code asks the creator to open the Social screen', async () => {
  await reset({ seed: seedOld });
  global.fetch = makeFakeX({ mode: 'email_code' }).fetch;
  const r = await xengine.act(account, 'like', { url: 'https://x.com/a/status/1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'code_required');
  assert.match(r.error, /Social screen/);
});

test('act: actions run strictly one at a time, never in parallel', async () => {
  await reset({ seed: seedGood });
  const url = (n) => `https://x.com/a/status/${n}`;
  const out = await Promise.all([1, 2, 3, 4].map((n) => xengine.act(account, 'like', { url: url(n) })));
  assert.ok(out.every((r) => r.ok));
  assert.equal(maxBusy, 1, 'at most one request in flight');
  assert.deepStrictEqual(calls.filter((c) => c.fn === 'likeTweet').map((c) => c.args[0]), ['1', '2', '3', '4'], 'in the order asked');
});

// ── reading DMs (how she receives messages) ─────────────────────────────────

test('read_dms: maps the inbox to {from, last_message, last_from_me}, using her own user id', async () => {
  await reset({ seed: seedGood }); // user_id 555
  inbox = { conversations: [
    { type: 'one_to_one', participants: [{ id: '555', username: 'ariana_x' }, { id: '10', username: 'bob' }], lastMessage: { text: 'hey you', senderId: '10' }, unreadCount: 1 },
    { type: 'one_to_one', participants: [{ id: '555', username: 'ariana_x' }, { id: '11', username: 'amy' }], lastMessage: { text: 'sent by her', senderId: '555' } },
    { type: 'one_to_one', participants: [{ id: '555', username: 'ariana_x' }, { id: '12', username: 'cat' }], lastMessage: { text: 'unknown sender' } },
    { type: 'group', participants: [{ id: '13', username: 'g1' }], lastMessage: { text: 'group chatter', senderId: '13' } },
    { type: 'one_to_one', participants: [{ id: '555', username: 'ariana_x' }, { id: '14', username: 'dan' }], lastMessage: { text: '' } },
  ] };
  const r = await xengine.act(account, 'read_dms', {});
  assert.equal(r.ok, true);
  assert.deepStrictEqual(r.result.items.map((i) => [i.from, i.last_message, i.last_from_me]), [
    ['bob', 'hey you', false],
    ['amy', 'sent by her', true],
    ['cat', 'unknown sender', null],
  ]);
});

// ── bookkeeping ─────────────────────────────────────────────────────────────

test('disconnect: deletes the saved login, so Connect has to sign in again', async () => {
  await reset({ seed: seedGood });
  assert.equal((await xengine.sessionStatus(account)).session.exists, true);
  const d = await xengine.disconnect(account);
  assert.equal(d.ok, true);
  assert.equal((await xengine.sessionStatus(account)).session.exists, false);
  assert.equal((await xengine.act(account, 'like', { url: 'https://x.com/a/status/1' })).code, 'no_session');
});

test('health and sessions report the truth: counts, storage, whether a server login is set', async () => {
  await reset({ creds: false });
  let h = (await xengine.health()).health;
  assert.deepStrictEqual({ provider: h.provider, sessions: h.sessions, accounts: h.accounts, login_configured: h.login_configured }, { provider: 'x-lite', sessions: 0, accounts: 1, login_configured: false });
  await reset({ seed: seedGood });
  h = (await xengine.health()).health;
  assert.equal(h.sessions, 1);
  assert.equal(h.login_configured, true);
  assert.match(h.session_storage, /encrypted/);
  const s = (await xengine.sessions()).sessions;
  assert.deepStrictEqual(s.map((x) => [x.account_id, x.exists]), [['twitter:ariana_x', true]]);
});

test('cookie import is gone, and says why', async () => {
  const r = await xengine.importSession();
  assert.equal(r.ok, false);
  assert.match(r.error, /signs in by itself/);
});

test('the real vendored client library loads under this Node (no stub)', async () => {
  await reset();
  xengine._setLibForTest(null); // use the real vendored modules
  process.env.XACTIONS_HOME = path.join(TMP, 'xactions-home');
  const v = await xengine.verify(account); // no session → resolves without any network, but only after the library imported
  assert.equal(v.ok, true);
  assert.equal(v.session.connected, false);
});
