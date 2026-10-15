'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPublisher, createStoryPoster } = require('../snapchat_publish');

function fakeFetch({ channels, failPublish } = {}) {
  const log = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    const body = init.body instanceof FormData ? { file: init.body.get('file') } : init.body ? JSON.parse(init.body) : null;
    log.push({ method: init.method || 'GET', url: u, auth: init.headers?.Authorization, body });
    const res = (code, o) => ({ ok: code < 400, status: code, text: async () => JSON.stringify(o), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    if (u.startsWith('https://cdn.example/')) return res(200, {});
    if (u.endsWith('/api/channels')) return res(200, { channels: channels || [{ id: 12, platform: 'snapchat', tokenStatus: 'valid' }, { id: 3, platform: 'x' }] });
    if (u.endsWith('/api/media')) return res(201, { file: { id: 42 } });
    if (u.endsWith('/api/posts')) return res(201, { post: { id: 'p1' } });
    if (u.endsWith('/publish')) return failPublish ? res(403, { error: { message: 'nope', code: 'PLATFORM_DISABLED' } }) : res(200, {});
    return res(404, {});
  };
  return { f, log };
}

test('story: uploads the picture, creates a draft for the Snapchat channel only, then publishes it', async () => {
  const { f, log } = fakeFetch();
  const p = createPublisher({ apiKey: 'bp_k', fetch: f });
  const r = await p.postStory('https://cdn.example/a/selfie.jpg?x=1');
  assert.deepEqual(r, { postId: 'p1', type: 'story' });
  const api = log.filter((l) => l.url.includes('bulkpublish.com'));
  assert.ok(api.every((l) => l.auth === 'Bearer bp_k'));
  const created = api.find((l) => l.url.endsWith('/api/posts')).body;
  assert.deepEqual(created.channels, [{ channelId: 12 }]);
  assert.deepEqual(created.mediaFiles, [42]);
  assert.equal(created.status, 'draft');
  assert.equal(created.postTypeOverrides.snapchat, 'story');
  assert.equal(created.content, ''); // stories carry no caption
  assert.ok(api[api.length - 1].url.endsWith('/api/posts/p1/publish'));
});

test('spotlight: video only, caption trimmed to 160 chars', async () => {
  const { f, log } = fakeFetch();
  const p = createPublisher({ apiKey: 'bp_k', fetch: f });
  await assert.rejects(p.postSpotlight('https://cdn.example/a.jpg', 'x'), /vertical video/);
  await p.postSpotlight('https://cdn.example/clip.mp4', 'a'.repeat(300));
  const created = log.find((l) => l.url.endsWith('/api/posts')).body;
  assert.equal(created.postTypeOverrides.snapchat, 'spotlight');
  assert.equal(created.content.length, 160);
  assert.equal(created.postFormat, 'video');
});

test('refuses non-https, wrong file types and missing key before touching the network', async () => {
  const { f, log } = fakeFetch();
  const p = createPublisher({ apiKey: 'bp_k', fetch: f });
  await assert.rejects(p.postStory('http://cdn.example/a.jpg'), /https/);
  await assert.rejects(p.postStory('https://cdn.example/a.gif'), /jpg, png, mp4 or mov/);
  await assert.rejects(createPublisher({ apiKey: '', fetch: f }).postStory('https://cdn.example/a.jpg'), /not configured/);
  assert.equal(log.length, 0);
});

test('clear errors when Snapchat is not connected or its login expired', async () => {
  await assert.rejects(createPublisher({ apiKey: 'k', fetch: fakeFetch({ channels: [{ id: 3, platform: 'x' }] }).f }).postStory('https://cdn.example/a.jpg'), /No Snapchat channel/);
  await assert.rejects(createPublisher({ apiKey: 'k', fetch: fakeFetch({ channels: [{ id: 5, platform: 'snapchat', tokenStatus: 'expired' }] }).f }).postStory('https://cdn.example/a.jpg'), /expired/);
});

test('API errors surface with status and code', async () => {
  const p = createPublisher({ apiKey: 'k', fetch: fakeFetch({ failPublish: true }).f });
  await assert.rejects(p.postStory('https://cdn.example/a.jpg'), (e) => e.status === 403 && e.code === 'PLATFORM_DISABLED' && /BulkPublish 403/.test(e.message));
});

test('story poster: plans a day, posts when due, never twice, avoids recent pictures', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')), 'plan.json');
  let t = Date.UTC(2026, 9, 15, 14, 0, 0); // 10:00 New York
  const posted = [];
  const sp = createStoryPoster({
    file, now: () => t, rand: () => 0.9, // one slot, late in the window
    enabled: () => true,
    pickMedia: async (recent) => ({ id: recent.includes('a') ? 'b' : 'a', url: `https://cdn.example/${recent.includes('a') ? 'b' : 'a'}.jpg` }),
    post: async (url) => { posted.push(url); },
  });
  assert.equal(await sp.tick(), false);           // plan made, nothing due yet
  assert.ok(sp.state.slots.length >= 1);
  t = Math.max(...sp.state.slots.map((s) => s.at)) + 1000;
  assert.equal(await sp.tick(), true);
  assert.equal(await sp.tick(), false);           // slot already used
  t += 4 * 3600 * 1000;
  while (await sp.tick()) {}                        // any second slot
  assert.ok(posted.length >= 1 && posted.length <= 2);
  if (posted.length === 2) assert.notEqual(posted[0], posted[1]);
});

test('story poster does nothing when disabled', async () => {
  const sp = createStoryPoster({ file: path.join(os.tmpdir(), 'ss-off.json'), enabled: () => false, pickMedia: async () => assert.fail('no'), post: async () => assert.fail('no') });
  assert.equal(await sp.tick(), false);
});
