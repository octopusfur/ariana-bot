// tests/social-manifest.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The capability contract is the reason this feature cannot lie to the creator,
// so it gets tested like one:
//
//   · every action marked supported names the real method behind it, and the
//     engine really has a handler for it (nothing advertised that cannot run);
//   · every action marked unsupported explains itself in a sentence a person
//     can read (no "N/A", no empty string);
//   · the platforms without an adapter say why, and are refused;
//   · the specific limitations (search, feed, notifications, deletes, connect)
//     are asserted to be exactly what they are.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const caps = require('../social/capabilities');
const xengine = require('../social/x_engine');

test('manifest: every supported action names a real method and what it returns', () => {
  for (const platform of caps.platformIds()) {
    for (const entry of caps.supportedActions(platform)) {
      assert.ok(entry.method, `${platform}/${entry.action} is marked supported but names no method`);
      assert.match(entry.method, /^[a-zA-Z]+\(/, `${platform}/${entry.action} method "${entry.method}" does not look like a call`);
    }
  }
});

test('manifest: every unsupported action explains itself properly', () => {
  for (const platform of caps.platformIds()) {
    for (const entry of caps.unsupportedActions(platform)) {
      assert.ok(entry.reason && entry.reason.length >= 30, `${platform}/${entry.action} has no usable explanation`);
      assert.ok(!/^(n\/a|not supported|unsupported|no)\.?$/i.test(entry.reason.trim()), `${platform}/${entry.action} has a placeholder reason`);
    }
  }
});

test('manifest: the engine has a handler for everything it advertises', () => {
  const handled = new Set(xengine.handledActions());
  const missing = caps.supportedActions('twitter').map((e) => e.action).filter((a) => !handled.has(a));
  assert.deepStrictEqual(missing, [], `advertised but not runnable: ${missing.join(', ')}`);
});

test('manifest: X is the only platform, and the ones without adapters say why', () => {
  assert.deepStrictEqual(caps.platformIds(), ['twitter']);
  const described = caps.describe();
  const unsupported = described.unsupported_platforms.map((u) => u.id);
  for (const p of ['instagram', 'linkedin', 'facebook', 'tiktok', 'threads', 'youtube']) {
    assert.ok(unsupported.includes(p), `${p} should be listed as having no adapter`);
  }
  for (const u of described.unsupported_platforms) {
    assert.ok(u.reason.length > 20, `${u.id} needs a reason`);
  }
});

// These are the limitations the design is built around. If a method is added to the X engine,
// these assertions should be the thing that fails first — deliberately, so the manifest is
// updated on purpose.
test('limits: X can publish, reply and repost', () => {
  for (const a of ['post', 'reply', 'comment', 'repost', 'like', 'follow', 'unfollow', 'dm']) {
    assert.equal(caps.supports('twitter', a), true, `X should support ${a}`);
  }
});

test('limits: X can read its DM inbox, which is how she receives messages', () => {
  assert.equal(caps.supports('twitter', 'read_dms'), true);
});

test('limits: search, notifications, the home feed and post lists are not built', () => {
  for (const a of ['search', 'notifications', 'view_feed', 'view_posts']) {
    assert.equal(caps.supports('twitter', a), false, `X must not claim ${a}`);
  }
  assert.match(caps.unsupportedReason('twitter', 'search'), /no search method/i);
});

test('limits: deletes are unsupported, because no method exists', () => {
  assert.equal(caps.supports('twitter', 'delete_post'), false);
  assert.equal(caps.supports('twitter', 'delete_comment'), false);
});

test('limits: connection requests are a LinkedIn concept and are not offered', () => {
  assert.equal(caps.supports('twitter', 'connect'), false);
});

test('check(): a refusal always carries a reason and a code', () => {
  const del = caps.check('twitter', 'delete_post');
  assert.equal(del.ok, false);
  assert.equal(del.code, 'unsupported');
  assert.ok(del.error.length > 30);

  for (const gone of ['instagram', 'linkedin']) {
    const r = caps.check(gone, 'like');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unsupported_platform');
  }

  const unknown = caps.check('myspace', 'like');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unsupported_platform');
  assert.match(unknown.error, /Supported platforms: twitter/);

  const ok = caps.check('twitter', 'like');
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.method, 'likeTweet(client, tweetId)');
});
