// tests/social-tools.test.js
// ─────────────────────────────────────────────────────────────────────────────
// What Ariana is offered, and what happens when she uses it.
//
// The important assertions in here are about honesty:
//   · the tool list contains exactly what the enabled accounts can really do —
//     no social_search, no social_connect, because X cannot do them here;
//   · nothing is sent to the engine when the platform cannot do it, when the
//     creator switched actions off, or when the call is a dry run;
//   · the activity log and the text handed back to the model both describe what
//     actually happened, failures included.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-social-tools-'));
process.env.SOCIAL_DATA_DIR = TMP;
delete process.env.SUPABASE_URL;
delete process.env.SOCIAL_DRY_RUN;

const accounts = require('../social/accounts');
const tools = require('../social/tools');
const activity = require('../social/activity');
const guards = require('../social/guards');
const engine = require('../social/engine_client');

// The engine is stubbed at the engine_client seam (the engine adapter has its own tests in
// x-engine.test.js). `calls` records exactly what would have been sent to X.
const real = { act: engine.act, configured: engine.configured };
let calls = [];

function fakeEngine(handler) {
  calls = [];
  engine.act = async (account, action, payload) => {
    calls.push({ account_id: account.account_id, action, payload });
    return handler ? handler({ account, action, payload }) : { ok: true, result: { success: true } };
  };
}

function resetStore() {
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) {
    try { fs.rmSync(path.join(TMP, f)); } catch (_) {}
  }
  accounts.invalidate();
  delete process.env.SOCIAL_DRY_RUN;
  engine.act = real.act;
  engine.configured = real.configured;
  calls = [];
}

async function enable(platform, handle) {
  const out = await accounts.add({ platform, handle });
  assert.equal(out.ok, true, out.error);
  await accounts.setActionsEnabled(out.account.account_id, true);
  return out.account.account_id;
}

test.after(() => {
  engine.act = real.act;
  engine.configured = real.configured;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ── WHAT SHE IS OFFERED ─────────────────────────────────────────────────────

test('tools: with no enabled account she is offered nothing at all', async () => {
  resetStore();
  await accounts.add({ platform: 'twitter', handle: 'disabled_one' }); // actions off
  assert.deepStrictEqual(await tools.buildToolSchemas(), []);
});

test('tools: on X she is offered what X can do, and nothing it cannot', async () => {
  resetStore();
  await enable('twitter', 'ArianaReyes');

  const schemas = await tools.buildToolSchemas();
  const names = schemas.map((t) => t.function.name);
  for (const expected of ['social_like', 'social_comment', 'social_reply', 'social_follow', 'social_unfollow', 'social_dm', 'social_view_profile', 'social_engagement', 'social_post', 'social_repost', 'social_accounts']) {
    assert.ok(names.includes(expected), `${expected} should be offered for X`);
  }
  for (const forbidden of ['social_search', 'social_connect', 'social_view_posts', 'social_view_feed']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be offered when it cannot work`);
  }

  // the description tells her where it works
  const post = schemas.find((t) => t.function.name === 'social_post');
  assert.match(post.function.description, /Works on: X/);
  assert.match(post.function.description, /not to farm engagement/);
});

test('tools: platforms the engine does not support cannot be added at all', async () => {
  resetStore();
  for (const platform of ['instagram', 'linkedin']) {
    const out = await accounts.add({ platform, handle: 'someone' });
    assert.equal(out.ok, false, `${platform} must be refused`);
    assert.match(out.error, /Supported: twitter/);
  }
});

// ── WHAT ACTUALLY LEAVES THE BUILDING ───────────────────────────────────────

test('execute: with the engine unavailable nothing is sent and the log says so', async () => {
  resetStore();
  fakeEngine();
  engine.configured = () => false;
  const id = await enable('twitter', 'ariana_personal');

  const result = await tools.executeTool('social_like', { url: 'https://x.com/a/status/111', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_configured');
  assert.equal(calls.length, 0, 'no engine, no request');
  assert.match(result.error, /X_PASSWORD/);

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.status_label, 'Failed');
  assert.match(entry.summary, /Could not like/i);
  assert.match(entry.error, /engine not connected/i);
  assert.match(tools.toolResultForModel(result), /no backend connected/i);
});

test('execute: a platform that cannot do it is refused locally, with the reason', async () => {
  resetStore();
  fakeEngine();
  const id = await enable('twitter', 'ariana_personal');

  // social_search is not even in her tool list here; calling it directly must not reach the engine either.
  const result = await tools.executeTool('social_search', { query: 'anything', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported');
  assert.match(result.error, /no search method/i);
  assert.equal(calls.length, 0, 'the engine is never troubled with an impossible action');

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'unsupported');
  assert.equal(entry.status_label, 'Not supported');
  assert.match(tools.toolResultForModel(result), /impossible on this platform/i);
});

test('execute: an action on a switched-off account is blocked before the engine', async () => {
  resetStore();
  fakeEngine();
  const out = await accounts.add({ platform: 'twitter', handle: 'off_account' });

  const result = await tools.executeTool('social_like', { url: 'https://x.com/a/status/222', account: out.account.account_id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'actions_disabled');
  assert.equal(calls.length, 0);
  const [entry] = await activity.recent(1, out.account.account_id);
  assert.equal(entry.status, 'blocked', 'the creator sees a permission stop, not a platform error');
});

test('execute: a dry run exercises everything but sends nothing', async () => {
  resetStore();
  process.env.SOCIAL_DRY_RUN = '1';
  fakeEngine();
  const id = await enable('twitter', 'ariana_personal');

  const result = await tools.executeTool('social_comment', { url: 'https://x.com/a/status/333', text: 'nice one', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dry_run');
  assert.equal(calls.length, 0);
  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'skipped');
  assert.equal(entry.detail.dry_run, true);
  assert.equal(entry.detail.would_send.text, 'nice one');
  process.env.SOCIAL_DRY_RUN = '';
});

test('execute: a real success is sent once, logged, and described as done', async () => {
  resetStore();
  const id = await enable('twitter', 'ariana_personal');
  fakeEngine(() => ({ ok: true, result: { success: true } }));

  const result = await tools.executeTool('social_like', { url: 'https://x.com/someone/status/444', account: id, username: 'someone' }, { source: 'chat' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].account_id, 'twitter:ariana_personal');
  assert.equal(calls[0].action, 'like');
  assert.deepStrictEqual(calls[0].payload, { url: 'https://x.com/someone/status/444' });

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'completed');
  assert.equal(entry.action, 'like');
  assert.equal(entry.summary, "Liked @someone's post");
  assert.equal(entry.actor, 'ariana');
  assert.ok(entry.duration_ms >= 0);

  assert.match(tools.toolResultForModel(result), /\[social action completed\]/);
});

test('execute: when the engine refuses, the failure is surfaced — never smoothed over', async () => {
  resetStore();
  const id = await enable('twitter', 'ariana_personal');
  fakeEngine(() => ({ ok: false, code: 'session_expired', error: 'The session is no longer logged in.' }));

  const result = await tools.executeTool('social_comment', { url: 'https://x.com/a/status/555', text: 'hi', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session_expired');
  assert.match(result.error, /no longer logged in/);

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'failed');
  assert.match(entry.summary, /Comment failed/i);
  assert.equal(entry.error, 'The session is no longer logged in.');
  assert.match(tools.toolResultForModel(result), /social action failed/);
});

test('execute: an account with no saved login fails loudly, not silently', async () => {
  resetStore();
  const id = await enable('twitter', 'ariana_personal');
  fakeEngine(() => ({ ok: false, code: 'no_session', error: 'This account has no saved X login yet. Tap Connect on it.' }));

  const result = await tools.executeTool('social_like', { url: 'https://x.com/a/status/556', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_session');
  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'failed');
  assert.match(entry.error, /Tap Connect/);
});

test('execute: she must name the account when two could do the job', async () => {
  resetStore();
  fakeEngine();
  await enable('twitter', 'ariana_personal');
  await enable('twitter', 'ariana_creator');

  const result = await tools.executeTool('social_like', { url: 'https://x.com/a/status/666' }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'account_required');
  assert.equal(calls.length, 0, 'never guess between two accounts');
  assert.match(result.error, /twitter:ariana_personal/);
  assert.match(result.error, /twitter:ariana_creator/);
});

test('execute: a batch is spaced sequentially and reported as one event', async () => {
  resetStore();
  const id = await enable('twitter', 'ariana_personal');
  fakeEngine(() => ({ ok: true, result: { success: true } }));

  const { token } = guards.createConfirmation({ accountId: id, action: 'like', maxTargets: 3 });
  const result = await tools.executeTool('social_like', {
    url: 'https://x.com/a/status/1',
    targets: ['https://x.com/a/status/2', 'https://x.com/a/status/3'],
    account: id,
  }, { source: 'chat', confirmationToken: token });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3, 'one request per target, none in parallel');
  assert.deepStrictEqual(calls.map((c) => c.payload.url), [
    'https://x.com/a/status/1', 'https://x.com/a/status/2', 'https://x.com/a/status/3',
  ]);
  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'completed');
  assert.equal(entry.detail.batch, 3);
  assert.equal(entry.detail.succeeded, 3);
});

test('execute: social_accounts tells her what she has and what it can do', async () => {
  resetStore();
  await enable('twitter', 'ariana_personal');
  const result = await tools.executeTool('social_accounts', {}, { source: 'chat' });
  assert.equal(result.ok, true);
  const x = result.data.platforms.find((p) => p.platform === 'twitter');
  assert.ok(x.can.includes('like'));
  assert.ok(x.can.includes('post'));
  assert.ok(x.cannot.some((c) => c.action === 'delete_post' && /no delete method/i.test(c.reason)));
});

test('execute: the tool list never claims a capability the manifest does not have', async () => {
  resetStore();
  const names = (await tools.buildToolSchemas()).map((t) => t.function.name);
  assert.deepStrictEqual(names, []);
});
