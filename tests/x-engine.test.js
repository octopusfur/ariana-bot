// tests/x-engine.test.js
// ─────────────────────────────────────────────────────────────────────────────
// X through the X service. What these pin down:
//
//   · NOTHING WAKES THE SERVICE BY ITSELF — status, sessions and health answer
//     locally; a bad request is rejected before any connection is made;
//   · the wake-up is absorbed (retries while it boots) but a WRITE IS NEVER
//     RETRIED — a timeout must not become a double post;
//   · Ariana cannot act as an account the service is not actually signed in as;
//   · every failure carries a code and a sentence a person can act on.
//
// The "X service" here is a real MCP server on a real local port, speaking the
// same protocol and the same tool/argument shapes the real service generates
// (those shapes were observed from x-service running xmcp, not guessed).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-x-engine-'));
process.env.SOCIAL_DATA_DIR = TMP;
delete process.env.SUPABASE_URL;
delete process.env.SOCIAL_ENGINE_URL;
delete process.env.BROWSER_USE_API_KEY;
delete process.env.SOCIAL_DRY_RUN;
process.env.X_SERVICE_RETRY_PAUSE_MS = '10';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const xe = require('../social/x_engine');
const engine = require('../social/engine_client');
const accounts = require('../social/accounts');
const tools = require('../social/tools');
const social = require('../social');

const KEY = 'k'.repeat(32);
const ME = { id: '111', name: 'Ariana Reyes', username: 'ariana_reyes' };
const SOMEONE = { id: '222', name: 'Some One', username: 'someone', description: 'hi', created_at: '2020-01-01T00:00:00.000Z', public_metrics: { followers_count: 10, following_count: 5, tweet_count: 42 } };

// The tool surface the real service generates for the eight allowlisted operations.
const TOOL_LIST = [
  { name: 'getUsersMe', props: {} },
  { name: 'getUsersByUsername', props: { username: {}, 'user.fields': {} } },
  { name: 'createPosts', props: { text: {}, reply: {} } },
  { name: 'likePost', props: { id: {}, tweet_id: {} } },
  { name: 'repostPost', props: { id: {}, tweet_id: {} } },
  { name: 'followUser', props: { id: {}, target_user_id: {} } },
  { name: 'unfollowUser', props: { source_user_id: {}, target_user_id: {} } },
  { name: 'createDirectMessagesByParticipantId', props: { participant_id: {}, text: {} } },
  { name: 'searchPostsRecent', props: { query: {}, max_results: {}, 'tweet.fields': {}, expansions: {}, 'user.fields': {} } },
  { name: 'getUsersPosts', props: { id: {}, max_results: {}, 'tweet.fields': {}, expansions: {}, 'user.fields': {} } },
  { name: 'getUsersTimeline', props: { id: {}, max_results: {}, 'tweet.fields': {}, expansions: {}, 'user.fields': {} } },
  { name: 'getUsersMentions', props: { id: {}, max_results: {}, 'tweet.fields': {}, expansions: {}, 'user.fields': {} } },
  { name: 'deletePosts', props: { id: {} } },
  { name: 'getDirectMessagesEvents', props: { max_results: {}, 'dm_event.fields': {}, expansions: {}, 'user.fields': {} } },
  { name: 'getDirectMessagesEventsByParticipantId', props: { participant_id: {}, max_results: {}, 'dm_event.fields': {}, expansions: {}, 'user.fields': {} } },
].map((t) => ({ name: t.name, description: t.name, inputSchema: { type: 'object', properties: t.props } }));

const ok = (data, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ data, ...extra }) }] });
const POST = (id, author_id = '222', text = 'a post') => ({ id, text, author_id, created_at: '2026-10-15T08:00:00.000Z' });
const WITH_USERS = { includes: { users: [{ id: '222', username: 'someone', name: 'Some One' }, { id: '333', username: 'third', name: 'Third' }] } };
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

function defaultRespond(name, args) {
  switch (name) {
    case 'getUsersMe': return ok(ME);
    case 'getUsersByUsername':
      return args.username.toLowerCase() === 'someone'
        ? ok(SOMEONE)
        : { content: [{ type: 'text', text: JSON.stringify({ errors: [{ title: 'Not Found Error', detail: `Could not find user with username: [${args.username}].`, type: 'https://api.twitter.com/2/problems/resource-not-found' }] }) }] };
    case 'createPosts': return ok({ id: '1900000000000000001', text: args.text });
    case 'likePost': return ok({ liked: true });
    case 'repostPost': return ok({ retweeted: true });
    case 'followUser': return ok({ following: true, pending_follow: false });
    case 'unfollowUser': return ok({ following: false });
    case 'createDirectMessagesByParticipantId': return ok({ dm_conversation_id: '222-111', dm_event_id: '9000' });
    case 'searchPostsRecent':
      return args.query === 'nothing-matches'
        ? { content: [{ type: 'text', text: JSON.stringify({ meta: { result_count: 0 } }) }] }
        : ok([POST('1700000000000000001'), POST('1700000000000000002', '333', 'another')], WITH_USERS);
    case 'getUsersPosts': return ok([POST('1600000000000000001')]); // no includes: the owner is known
    case 'getUsersTimeline': return ok([POST('1500000000000000001', '333', 'from the feed')], WITH_USERS);
    case 'getUsersMentions': return ok([POST('1400000000000000001', '333', '@ariana_reyes hi')], WITH_USERS);
    case 'getDirectMessagesEvents':
    case 'getDirectMessagesEventsByParticipantId':
      return ok([
        { id: '9001', event_type: 'MessageCreate', sender_id: '222', text: 'hey you', created_at: '2026-10-15T07:00:00.000Z' },
        { id: '9002', event_type: 'ParticipantsJoin', sender_id: '222' },
        { id: '9003', event_type: 'MessageCreate', sender_id: '111', text: 'hi!', created_at: '2026-10-15T07:05:00.000Z' },
      ], WITH_USERS);
    case 'deletePosts': return ok({ deleted: true });
    default: return fail(`Unknown tool: ${name}`);
  }
}

// A real MCP-over-HTTP server, stateless like the real service.
async function startService({ respond = defaultRespond, tools: list = TOOL_LIST, wakeFailures = 0, hang = null } = {}) {
  const state = { http: 0, calls: [], wakeLeft: wakeFailures, headers: [] };
  const srv = http.createServer(async (req, res) => {
    state.http++;
    state.headers.push(req.headers['x-api-key']);
    if (req.headers['x-api-key'] !== KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    if (state.wakeLeft > 0) { // still "waking up"
      state.wakeLeft--;
      res.writeHead(503);
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const server = new Server({ name: 'fake-x', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const { name, arguments: args } = r.params;
      state.calls.push({ name, args });
      if (hang && hang === name) await new Promise(() => {}); // never answers
      return respond(name, args || {});
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, state, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

function point(url, key = KEY) {
  process.env.X_SERVICE_URL = url;
  if (key === null) delete process.env.X_SERVICE_API_KEY; else process.env.X_SERVICE_API_KEY = key;
  xe._resetForTests();
}

const ARIANA = { account_id: 'twitter:ariana_reyes', platform: 'twitter', handle: 'ariana_reyes' };

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// ── CONFIG ──────────────────────────────────────────────────────────────────

test('config: both the URL and the key are required, and /mcp pasted in full is tolerated', () => {
  delete process.env.X_SERVICE_URL; delete process.env.X_SERVICE_API_KEY;
  assert.equal(xe.configured(), false);
  process.env.X_SERVICE_URL = 'https://ariana-x.onrender.com/mcp/';
  assert.equal(xe.configured(), false, 'a URL without a key must not count — the service must never be called unauthenticated');
  process.env.X_SERVICE_API_KEY = KEY;
  assert.equal(xe.configured(), true);
  assert.equal(xe.baseUrl(), 'https://ariana-x.onrender.com');
  process.env.X_SERVICE_URL = 'ariana-x.onrender.com';
  assert.equal(xe.configured(), false, 'a URL without a scheme is rejected, not guessed');
});

test('act: not configured says exactly what to set and sends nothing', async () => {
  point('', null);
  const r = await xe.act(ARIANA, 'post', { text: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_configured');
  assert.match(r.error, /X_SERVICE_URL/);
});

// ── THE NO-PINGING RULE ─────────────────────────────────────────────────────

test('idle: health, sessions and session status never touch the network', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const h = await xe.health();
    assert.equal(h.ok, true);
    assert.equal(h.health.mode, 'on-demand');
    assert.equal((await xe.sessions()).ok, true);
    assert.equal((await xe.sessionStatus(ARIANA)).session.has_session, true);
    // …and the same through the engine client the dashboard uses
    assert.equal((await engine.health()).health.provider, 'x-api');
    assert.deepStrictEqual((await engine.sessions()).sessions, []);
    assert.equal(svc.state.http, 0, 'the service must not be contacted by status checks');
  } finally { await svc.close(); }
});

test('idle: nothing is scheduled by loading the X engine or the social layer', () => {
  // Loading the modules above must not have left a timer or interval running
  // that could ever call the service: the X engine owns no timers at all.
  const src = fs.readFileSync(path.join(__dirname, '..', 'social', 'x_engine.js'), 'utf8');
  assert.ok(!/setInterval\s*\(/.test(src), 'x_engine.js must not use setInterval');
  assert.ok(!/cron|keep-?alive|ping\s*\(/i.test(src.replace(/\/\/.*$/gm, '')), 'no cron, keep-alive or ping in x_engine.js code');
});

test('validation happens before the service is woken', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    for (const [action, payload, why] of [
      ['like', { url: 'https://example.com/not-x' }, 'not an X link'],
      ['reply', { url: 'https://x.com/someone/status/1234567890123', text: '   ' }, 'empty text'],
      ['post', { text: '' }, 'empty post'],
      ['follow', { username: 'bad handle!' }, 'invalid handle'],
      ['dm', { username: 'someone', message: '' }, 'empty dm'],
    ]) {
      const r = await xe.act(ARIANA, action, payload);
      assert.equal(r.ok, false, why);
      assert.equal(r.code, 'bad_target', why);
    }
    assert.equal((await xe.act(ARIANA, 'connect', { profileUrl: 'x' })).code, 'unsupported');
    assert.equal((await xe.act(ARIANA, 'search', { query: '   ' })).code, 'bad_target');
    assert.equal(svc.state.http, 0, 'bad input must cost no request at all');
  } finally { await svc.close(); }
});

// ── WAKING AND NEVER DOUBLE-WRITING ─────────────────────────────────────────

test('wake: connection retries while the service boots, and the write is sent exactly once', async () => {
  const svc = await startService({ wakeFailures: 2 }); // first two requests: 503, as when waking
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'post', { text: 'good morning' });
    assert.equal(r.ok, true, r.error);
    assert.equal(svc.state.calls.filter((c) => c.name === 'createPosts').length, 1, 'exactly one post');
  } finally { await svc.close(); }
});

test('wake: a service that never comes up fails clearly within the budget', async () => {
  process.env.X_SERVICE_WAKE_MS = '400';
  point('http://127.0.0.1:9'); // nothing listens here
  const t0 = Date.now();
  const r = await xe.act(ARIANA, 'post', { text: 'hello' });
  delete process.env.X_SERVICE_WAKE_MS;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unreachable');
  assert.ok(Date.now() - t0 < 3000, 'must give up inside the wake budget');
});

test('write is never retried: a timeout reports "may have gone through" and sends once', async () => {
  const svc = await startService({ hang: 'createPosts' });
  process.env.X_SERVICE_CALL_MS = '300';
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'post', { text: 'hello' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'timeout');
    assert.match(r.error, /may still have gone through/);
    assert.equal(svc.state.calls.filter((c) => c.name === 'createPosts').length, 1, 'a timed-out write must not be re-sent');
  } finally { delete process.env.X_SERVICE_CALL_MS; await svc.close(); }
});

test('auth: a wrong key is reported as such and is not retried', async () => {
  const svc = await startService();
  point(svc.url, 'wrong-key-wrong-key-wrong-key-123');
  try {
    const r = await xe.act(ARIANA, 'like', { url: 'https://x.com/someone/status/1234567890123' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unauthorized');
    assert.match(r.error, /X_SERVICE_API_KEY/);
    assert.equal(svc.state.http, 1, 'one attempt, no retry storm');
  } finally { await svc.close(); }
});

test('auth: the key is sent on every request', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    await xe.act(ARIANA, 'view_profile', { username: 'someone' });
    assert.ok(svc.state.http > 1);
    assert.ok(svc.state.headers.every((h) => h === KEY));
  } finally { await svc.close(); }
});

// ── IDENTITY ────────────────────────────────────────────────────────────────

test('identity: if the service is signed in as someone else, nothing is written', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act({ ...ARIANA, handle: 'ariana_other' }, 'post', { text: 'wrong account?' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'account_mismatch');
    assert.match(r.error, /@ariana_reyes/);
    assert.match(r.error, /Nothing was sent/);
    assert.equal(svc.state.calls.filter((c) => c.name === 'createPosts').length, 0);
  } finally { await svc.close(); }
});

test('identity: handle comparison ignores @ and case', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act({ ...ARIANA, handle: '@Ariana_Reyes' }, 'like', { url: 'https://x.com/someone/status/1234567890123' });
    assert.equal(r.ok, true, r.error);
  } finally { await svc.close(); }
});

// ── THE ACTIONS, AS SENT TO X ───────────────────────────────────────────────

test('post: sends the text, returns the live URL under the right account', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'post', { text: '  hello world  ' });
    assert.equal(r.ok, true, r.error);
    assert.deepStrictEqual(svc.state.calls.map((c) => c.name), ['getUsersMe', 'createPosts']);
    assert.deepStrictEqual(svc.state.calls[1].args, { text: 'hello world' });
    assert.equal(r.result.data.url, 'https://x.com/ariana_reyes/status/1900000000000000001');
  } finally { await svc.close(); }
});

test('reply and comment: the tweet id is parsed from the link and sent as in_reply_to', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'reply', { url: 'https://twitter.com/someone/status/1850000000000000009?s=20', text: 'nice' });
    assert.equal(r.ok, true, r.error);
    assert.deepStrictEqual(svc.state.calls[1].args, { text: 'nice', reply: { in_reply_to_tweet_id: '1850000000000000009' } });
    assert.equal(r.result.data.in_reply_to, '1850000000000000009');
  } finally { await svc.close(); }
});

test('like and repost: use the signed-in account id plus the tweet id', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const url = 'https://x.com/someone/status/1850000000000000009';
    assert.equal((await xe.act(ARIANA, 'like', { url })).ok, true);
    assert.equal((await xe.act(ARIANA, 'repost', { url })).ok, true);
    const writes = svc.state.calls.filter((c) => c.name !== 'getUsersMe');
    assert.deepStrictEqual(writes, [
      { name: 'likePost', args: { id: '111', tweet_id: '1850000000000000009' } },
      { name: 'repostPost', args: { id: '111', tweet_id: '1850000000000000009' } },
    ]);
    assert.equal(svc.state.calls.filter((c) => c.name === 'getUsersMe').length, 1, 'identity is cached between actions, not re-fetched each time');
  } finally { await svc.close(); }
});

test('follow, unfollow and dm: the handle is resolved to an id first', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const f = await xe.act(ARIANA, 'follow', { username: '@someone' });
    assert.equal(f.ok, true, f.error);
    assert.equal(f.result.data.following, true);
    assert.equal((await xe.act(ARIANA, 'unfollow', { username: 'someone' })).ok, true);
    assert.equal((await xe.act(ARIANA, 'dm', { username: 'someone', message: 'hey' })).ok, true);
    const writes = svc.state.calls.filter((c) => !['getUsersMe', 'getUsersByUsername'].includes(c.name));
    assert.deepStrictEqual(writes, [
      { name: 'followUser', args: { id: '111', target_user_id: '222' } },
      { name: 'unfollowUser', args: { source_user_id: '111', target_user_id: '222' } },
      { name: 'createDirectMessagesByParticipantId', args: { participant_id: '222', text: 'hey' } },
    ]);
  } finally { await svc.close(); }
});

test('follow: a protected account answers "pending", and that is reported as pending, not as following', async () => {
  const svc = await startService({ respond: (n, a) => (n === 'followUser' ? ok({ following: false, pending_follow: true }) : defaultRespond(n, a)) });
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'follow', { username: 'someone' });
    assert.equal(r.ok, true);
    assert.deepStrictEqual(r.result.data, { following: false, pending: true, username: 'someone' });
  } finally { await svc.close(); }
});

test('follow: following yourself is refused locally after lookup, with no write', async () => {
  const svc = await startService({ respond: (n, a) => (n === 'getUsersByUsername' ? ok({ ...ME, public_metrics: {} }) : defaultRespond(n, a)) });
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'follow', { username: 'ariana_reyes' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad_target');
    assert.equal(svc.state.calls.filter((c) => c.name === 'followUser').length, 0);
  } finally { await svc.close(); }
});

test('view_profile and engagement: shaped for Ariana, not raw API output', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const p = await xe.act(ARIANA, 'view_profile', { username: 'someone' });
    assert.equal(p.ok, true, p.error);
    assert.deepStrictEqual(p.result.data, { username: 'someone', name: 'Some One', bio: 'hi', followers: 10, following: 5, tweets: 42, joined: '2020-01-01T00:00:00.000Z', protected: false, url: 'https://x.com/someone' });
    const e = await xe.act(ARIANA, 'engagement', { username: 'someone' });
    assert.deepStrictEqual(e.result.data, { username: 'someone', followers: 10, following: 5, tweets: 42 });
  } finally { await svc.close(); }
});

test('not found: an unknown handle is a failure with a readable reason, not an empty success', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'view_profile', { username: 'nobody_here' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_found');
    assert.match(r.error, /@nobody_here was not found/);
  } finally { await svc.close(); }
});

// ── FAILURES, IN WORDS ──────────────────────────────────────────────────────

test('parseToolResult: the real error shapes become codes and advice', () => {
  const t = (text) => xe.parseToolResult({ isError: true, content: [{ type: 'text', text }] });
  assert.equal(t("Error calling tool 'createPosts': HTTP error 403: Forbidden - {'title': 'Forbidden', 'status': 403, 'detail': 'You are not permitted to perform this action.'}").code, 'x_forbidden');
  assert.match(t("HTTP error 403: Forbidden - {'detail': 'You are not permitted to perform this action.'}").error, /not permitted to perform this action/);
  assert.equal(t('Rate limited by upstream API, please retry later').code, 'rate_limited');
  assert.equal(t('HTTP error 401: Unauthorized').code, 'x_unauthorized');
  assert.equal(t('HTTP error 402: Payment Required').code, 'x_payment_required');
  assert.equal(t('Unknown tool: createPosts').code, 'tool_missing');
  assert.equal(t('something odd').code, 'x_error');
  // a 200 that carries only `errors` is a failure
  const nf = xe.parseToolResult({ content: [{ type: 'text', text: JSON.stringify({ errors: [{ title: 'Not Found Error', type: 'x/resource-not-found', detail: 'gone' }] }) }] });
  assert.deepStrictEqual([nf.ok, nf.code, nf.error], [false, 'not_found', 'gone']);
  assert.equal(xe.parseToolResult(null).ok, false);
  assert.equal(xe.parseToolResult({ content: [{ type: 'text', text: 'not json' }] }).ok, false);
});

test('a refusal from X surfaces as a failure and the write is not claimed', async () => {
  const svc = await startService({ respond: (n, a) => (n === 'createPosts' ? fail("HTTP error 403: Forbidden - {'detail': 'You are not permitted to perform this action.'}") : defaultRespond(n, a)) });
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'post', { text: 'hello' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'x_forbidden');
  } finally { await svc.close(); }
});

test('target parsing', () => {
  assert.equal(xe.parseTweetId('https://x.com/a/status/1234567890123'), '1234567890123');
  assert.equal(xe.parseTweetId('https://twitter.com/a/statuses/1234567890123?s=1'), '1234567890123');
  assert.equal(xe.parseTweetId('1234567890123'), '1234567890123');
  assert.equal(xe.parseTweetId('https://x.com/a'), null);
  assert.equal(xe.parseTweetId('https://evil.com/x.com/a/status/12'), null);
  assert.equal(xe.normalizeUsername('@ok_name1'), 'ok_name1');
  assert.equal(xe.normalizeUsername('way_too_long_handle_here'), null);
  assert.equal(xe.normalizeUsername('a/b'), null);
  assert.equal(xe.normalizeUsername('../me'), null);
});

// ── CONNECT (the one deliberate round trip) ─────────────────────────────────

test('verify: reports the live account, and checks the tool surface', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const v = await xe.verify(ARIANA);
    assert.equal(v.ok, true);
    assert.equal(v.session.connected, true);
    assert.match(v.session.detail, /signed in as @ariana_reyes/);
  } finally { await svc.close(); }
});

test('verify: a service whose tools do not fit is reported in words, not discovered mid-chat', async () => {
  const wrong = TOOL_LIST.map((t) => (t.name === 'createPosts' ? { ...t, inputSchema: { type: 'object', properties: { body: {} } } } : t))
    .filter((t) => t.name !== 'followUser');
  const svc = await startService({ tools: wrong });
  point(svc.url);
  try {
    const v = await xe.verify(ARIANA);
    assert.equal(v.ok, true);
    assert.equal(v.session.connected, false);
    assert.match(v.session.detail, /followUser is not exposed/);
    assert.match(v.session.detail, /createPosts does not take text, reply \(it takes: body\)/);
  } finally { await svc.close(); }
});

test('verify: signed in as a different account is "not connected", with the reason', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const v = await xe.verify({ ...ARIANA, handle: 'someone_else' });
    assert.equal(v.session.connected, false);
    assert.match(v.session.detail, /signed in as @ariana_reyes, not @someone_else/);
  } finally { await svc.close(); }
});

// ── ROUTING AND THE REAL TOOL PATH ──────────────────────────────────────────

test('routing: only X accounts go to the X service; other platforms are untouched', () => {
  point('https://ariana-x.example');
  assert.equal(engine.routesToX({ platform: 'twitter' }), true);
  assert.equal(engine.routesToX({ platform: 'instagram' }), false);
  assert.equal(engine.routesToX({ platform: 'linkedin' }), false);
  assert.equal(engine.provider(), 'x-api');
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  try {
    assert.equal(engine.provider(), 'socialcrabs', 'an existing engine still owns the provider label');
    assert.equal(engine.routesToX({ platform: 'twitter' }), true, 'but X accounts still use the official API');
  } finally { delete process.env.SOCIAL_ENGINE_URL; }
});

test('end to end: Ariana\'s own like goes tools → guards → X service → X, and is logged', async () => {
  const svc = await startService();
  point(svc.url);
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) { try { fs.rmSync(path.join(TMP, f)); } catch (_) {} }
  accounts.invalidate();
  try {
    const added = await accounts.add({ platform: 'twitter', handle: 'ariana_reyes' });
    await accounts.setActionsEnabled(added.account.account_id, true);

    const names = (await social.buildToolSchemas()).map((t) => t.function.name);
    assert.ok(names.includes('social_like') && names.includes('social_post'), 'with only the X service configured she is handed X tools');

    const res = await tools.executeTool('social_like', { url: 'https://x.com/someone/status/1850000000000000009', account: 'twitter:ariana_reyes' }, { source: 'chat', actor: 'ariana' });
    assert.equal(res.ok, true, res.error);
    assert.match(tools.toolResultForModel(res), /social action completed/);
    assert.ok(svc.state.calls.some((c) => c.name === 'likePost'));
  } finally { await svc.close(); }
});


// ── COMMENT IS A REPLY ──────────────────────────────────────────────────────

test('comment: the tool layer sends `comment` for X replies, and it works exactly like reply', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'comment', { url: 'https://x.com/someone/status/1850000000000000009', text: 'love this' });
    assert.equal(r.ok, true, r.error);
    assert.deepStrictEqual(svc.state.calls[1].args, { text: 'love this', reply: { in_reply_to_tweet_id: '1850000000000000009' } });
  } finally { await svc.close(); }
});

// ── ALL THE READS ───────────────────────────────────────────────────────────

test('search: returns post links with authors resolved from the expansion; empty results are an empty list', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'search', { query: 'ai influencers' });
    assert.equal(r.ok, true, r.error);
    assert.deepStrictEqual(r.result.data.posts.map((p) => [p.author, p.url]), [
      ['someone', 'https://x.com/someone/status/1700000000000000001'],
      ['third', 'https://x.com/third/status/1700000000000000002'],
    ]);
    const call = svc.state.calls.find((c) => c.name === 'searchPostsRecent');
    assert.equal(call.args.query, 'ai influencers');
    assert.equal(call.args.max_results, 20);
    assert.deepStrictEqual(call.args.expansions, ['author_id']);

    const none = await xe.act(ARIANA, 'search', { query: 'nothing-matches' });
    assert.equal(none.ok, true);
    assert.deepStrictEqual(none.result.data.posts, []);
    assert.equal((await xe.act(ARIANA, 'search', { query: 'x'.repeat(513) })).code, 'bad_target');
  } finally { await svc.close(); }
});

test('view_posts: resolves the handle first and links posts under that account', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'view_posts', { username: '@someone' });
    assert.equal(r.ok, true, r.error);
    assert.deepStrictEqual(svc.state.calls.map((c) => c.name), ['getUsersMe', 'getUsersByUsername', 'getUsersPosts']);
    assert.equal(svc.state.calls[2].args.id, '222');
    assert.equal(r.result.data.posts[0].url, 'https://x.com/someone/status/1600000000000000001');
  } finally { await svc.close(); }
});

test('view_feed and notifications: read as the signed-in account', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const feed = await xe.act(ARIANA, 'view_feed', {});
    assert.equal(feed.ok, true, feed.error);
    assert.equal(feed.result.data.posts[0].author, 'third');
    const mentions = await xe.act(ARIANA, 'notifications', {});
    assert.equal(mentions.ok, true, mentions.error);
    assert.equal(mentions.result.data.kind, 'mentions');
    assert.match(mentions.result.data.items[0].text, /@ariana_reyes hi/);
    for (const name of ['getUsersTimeline', 'getUsersMentions']) {
      assert.equal(svc.state.calls.find((c) => c.name === name).args.id, '111');
    }
  } finally { await svc.close(); }
});

test('read_dms: whole inbox or one thread; only real messages; marks which are hers', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const inbox = await xe.act(ARIANA, 'read_dms', {});
    assert.equal(inbox.ok, true, inbox.error);
    assert.ok(svc.state.calls.some((c) => c.name === 'getDirectMessagesEvents'));
    assert.deepStrictEqual(inbox.result.data.items.map((m) => [m.from, m.from_me, m.text]), [
      ['someone', false, 'hey you'],
      ['111', true, 'hi!'], // not in the expansion → falls back to the id, still marked as hers
    ], 'join/leave events are dropped');

    const thread = await xe.act(ARIANA, 'read_dms', { username: 'someone' });
    assert.equal(thread.ok, true, thread.error);
    assert.equal(svc.state.calls.find((c) => c.name === 'getDirectMessagesEventsByParticipantId').args.participant_id, '222');
    assert.equal((await xe.act(ARIANA, 'read_dms', { username: 'no spaces!' })).code, 'bad_target');
  } finally { await svc.close(); }
});

// ── DELETING — OWN POSTS ONLY ───────────────────────────────────────────────

test('delete_post and delete_comment: her own post is deleted', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    for (const action of ['delete_post', 'delete_comment']) {
      const r = await xe.act(ARIANA, action, { url: 'https://x.com/Ariana_Reyes/status/1850000000000000009' });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.result.data.deleted, true);
    }
    assert.deepStrictEqual(svc.state.calls.filter((c) => c.name === 'deletePosts').map((c) => c.args), [{ id: '1850000000000000009' }, { id: '1850000000000000009' }]);
  } finally { await svc.close(); }
});

test('delete: somebody else\'s post is refused and X is never asked', async () => {
  const svc = await startService();
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'delete_post', { url: 'https://x.com/someone/status/1850000000000000009' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_yours');
    assert.match(r.error, /Nothing was sent/);
    assert.equal(svc.state.calls.filter((c) => c.name === 'deletePosts').length, 0);
    assert.equal((await xe.act(ARIANA, 'delete_post', { url: 'not a link' })).code, 'bad_target');
  } finally { await svc.close(); }
});

// ── A TRIMMED ALLOWLIST DEGRADES, IT DOES NOT BREAK ─────────────────────────

test('optional tools: Connect still succeeds when the service leaves some out, and says which', async () => {
  const trimmed = TOOL_LIST.filter((t) => !['searchPostsRecent', 'deletePosts'].includes(t.name));
  const svc = await startService({ tools: trimmed });
  point(svc.url);
  try {
    const v = await xe.verify(ARIANA);
    assert.equal(v.session.connected, true, v.session.detail);
    assert.match(v.session.detail, /Not exposed by the service.*searchPostsRecent, deletePosts/);
  } finally { await svc.close(); }
});

test('optional tools: using a feature the service does not expose says so plainly', async () => {
  const svc = await startService({ respond: (n, a) => (n === 'searchPostsRecent' ? fail('Unknown tool: searchPostsRecent') : defaultRespond(n, a)) });
  point(svc.url);
  try {
    const r = await xe.act(ARIANA, 'search', { query: 'anything' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'tool_missing');
    assert.match(r.error, /X_API_TOOL_ALLOWLIST/);
  } finally { await svc.close(); }
});

// ── THE CAPABILITY OVERLAY CANNOT LIE ───────────────────────────────────────

test('overlay: what the manifest promises for X, the engine can do — and the reverse', () => {
  const caps = require('../social/capabilities');
  const overlay = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'social', 'capabilities.x-api.json'), 'utf8')).platforms.twitter.actions;
  const handlers = new Set(xe.supportedActions());
  const supported = Object.entries(overlay).filter(([, e]) => e.supported).map(([a]) => a);

  for (const a of supported) {
    assert.ok(handlers.has(a), `overlay says X can ${a} but x_engine has no handler for it`);
    assert.match(overlay[a].method, /^xapi\.[a-zA-Z]+\(/, `${a} must name the X API operation behind it`);
    assert.ok(tools.TOOL_FOR_ACTION[a], `${a} is supported on X but Ariana is never offered a tool for it`);
  }
  for (const h of handlers) assert.ok(supported.includes(h), `x_engine can ${h} but the overlay does not claim it`);
  for (const [a, e] of Object.entries(overlay)) {
    if (!e.supported) assert.ok(e.reason && e.reason.length > 20, `${a} is unsupported without a readable reason`);
    assert.ok(caps.actionNames().includes(a), `${a} is not a canonical action`);
  }
});

test('overlay: applies only while the X service is configured, and only to X', () => {
  const caps = require('../social/capabilities');
  const saved = [process.env.X_SERVICE_URL, process.env.X_SERVICE_API_KEY];
  try {
    point('', null);
    assert.equal(caps.supports('twitter', 'search'), false, 'without the X service the old manifest still applies');
    assert.equal(caps.supports('twitter', 'delete_post'), false);
    point('https://ariana-x.example');
    for (const a of ['search', 'view_posts', 'view_feed', 'notifications', 'read_dms', 'delete_post', 'delete_comment']) {
      assert.equal(caps.supports('twitter', a), true, a);
    }
    assert.equal(caps.supports('instagram', 'view_feed'), false, 'other platforms are untouched');
    assert.equal(caps.supports('linkedin', 'read_dms'), false);
    assert.equal(caps.supports('instagram', 'view_posts'), true);
  } finally {
    if (saved[0] === undefined) delete process.env.X_SERVICE_URL; else process.env.X_SERVICE_URL = saved[0];
    if (saved[1] === undefined) delete process.env.X_SERVICE_API_KEY; else process.env.X_SERVICE_API_KEY = saved[1];
  }
});

// ── WHAT ARIANA IS OFFERED, AND WHAT STOPS TO ASK ───────────────────────────

test('tools: with the X service she is offered every X ability; Instagram alone gains nothing', async () => {
  const svc = await startService();
  point(svc.url);
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) { try { fs.rmSync(path.join(TMP, f)); } catch (_) {} }
  accounts.invalidate();
  try {
    const ig = await accounts.add({ platform: 'instagram', handle: 'ariana.personal' });
    await accounts.setActionsEnabled(ig.account.account_id, true);
    const igOnly = (await tools.buildToolSchemas()).map((t) => t.function.name);
    for (const n of ['social_view_feed', 'social_read_dms', 'social_notifications', 'social_delete_post', 'social_search']) {
      assert.ok(!igOnly.includes(n), `${n} must not appear for Instagram alone`);
    }

    const x = await accounts.add({ platform: 'twitter', handle: 'ariana_reyes' });
    await accounts.setActionsEnabled(x.account.account_id, true);
    const schemas = await tools.buildToolSchemas();
    const names = schemas.map((t) => t.function.name);
    for (const n of ['social_search', 'social_view_posts', 'social_view_feed', 'social_notifications', 'social_read_dms', 'social_delete_post', 'social_delete_comment', 'social_post', 'social_repost', 'social_reply', 'social_comment']) {
      assert.ok(names.includes(n), `${n} should be offered once X is connected`);
    }
    const dms = schemas.find((t) => t.function.name === 'social_read_dms').function.parameters;
    assert.ok(dms.properties.username, 'a thread can be named');
    assert.ok(!dms.required.includes('username'), 'but naming one is optional');
  } finally { await svc.close(); }
});

test('safety wiring: deleting and reading DMs stop for the creator\'s yes BEFORE anything reaches X', async () => {
  const svc = await startService();
  point(svc.url);
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) { try { fs.rmSync(path.join(TMP, f)); } catch (_) {} }
  accounts.invalidate();
  try {
    const x = await accounts.add({ platform: 'twitter', handle: 'ariana_reyes' });
    await accounts.setActionsEnabled(x.account.account_id, true);
    const ctx = { source: 'chat', actor: 'ariana' };

    const del = await tools.executeTool('social_delete_post', { url: 'https://x.com/ariana_reyes/status/1850000000000000009', account: 'twitter:ariana_reyes' }, ctx);
    assert.equal(del.ok, false);
    assert.equal(del.code, 'needs_confirmation');
    const dms = await tools.executeTool('social_read_dms', { account: 'twitter:ariana_reyes' }, ctx);
    assert.equal(dms.code, 'needs_confirmation');
    assert.equal(svc.state.http, 0, 'neither may touch the service — or wake it — without a yes');

    // reads that are not sensitive just work, and she sees the whole list, not 800 characters of it
    const feed = await tools.executeTool('social_view_feed', { account: 'twitter:ariana_reyes' }, ctx);
    assert.equal(feed.ok, true, feed.error);
    assert.match(tools.toolResultForModel(feed), /from the feed/);
  } finally { await svc.close(); }
});
