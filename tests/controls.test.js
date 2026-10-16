"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { create, defaults, sanitize } = require("../controls");

const tmp = () => path.join(os.tmpdir(), "controls_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".json");

test("defaults come from the old env vars on first run", () => {
  const d = defaults({ STATUS_POSTS_MIN: "1", STATUS_POSTS_MAX: "4", TG_STORY_POSTS: "off", PHOTO_DAILY_CAP: "9", MEMORY_AUTO_APPROVE: "off", WA_STATUS_POSTS: "off" });
  assert.deepStrictEqual([d.status.postsMin, d.status.postsMax, d.status.telegramStory, d.photos.dailyCap, d.memory.autoApprove, d.status.enabled], [1, 4, false, 9, false, false]);
  const plain = defaults({});
  assert.deepStrictEqual([plain.status.postsMin, plain.status.postsMax, plain.status.enabled, plain.photos.cooldownMin, plain.photos.sendToOthers], [2, 3, true, 5, true]);
});

test("updates persist across a restart, and only the sent fields change", () => {
  const f = tmp();
  const a = create({ file: f, env: {} });
  a.update({ status: { postsMax: 5, kinds: { found: false } }, photos: { cooldownMin: 30 } });
  const b = create({ file: f, env: {} }); // "restart"
  assert.strictEqual(b.get().status.postsMax, 5);
  assert.strictEqual(b.get().status.kinds.found, false);
  assert.strictEqual(b.get().status.kinds.photo, true, "untouched values stay as they were");
  assert.strictEqual(b.get().photos.cooldownMin, 30);
  assert.strictEqual(b.get().photos.dailyCap, 5);
});

test("bad input is clamped or ignored, never stored", () => {
  const base = defaults({});
  const s = sanitize({ status: { postsMin: 99, postsMax: -4, enabled: "yes", kinds: { text: "no" } }, photos: { cooldownMin: "abc", dailyCap: 1e9 }, evil: { x: 1 } }, base);
  assert.strictEqual(s.status.postsMin, 6);
  assert.ok(s.status.postsMax >= s.status.postsMin);
  assert.strictEqual(s.status.enabled, true, "non-boolean ignored");
  assert.strictEqual(s.status.kinds.text, true);
  assert.strictEqual(s.photos.cooldownMin, 5);
  assert.strictEqual(s.photos.dailyCap, 50);
  assert.strictEqual(s.evil, undefined);
});

test("she can never be left with nothing to post", () => {
  const c = create({ file: tmp(), env: {} });
  c.update({ status: { kinds: { text: false, photo: false, found: false }, topics: { funny: false, news: false } } });
  const k = c.get().status;
  assert.ok(k.kinds.text || k.kinds.photo || k.kinds.found);
  assert.ok(k.topics.funny || k.topics.news);
});

test("a corrupt controls file falls back to defaults instead of crashing", () => {
  const f = tmp(); fs.writeFileSync(f, "{not json");
  assert.strictEqual(create({ file: f, env: {} }).get().photos.dailyCap, 5);
});

test("reset restores the defaults", () => {
  const c = create({ file: tmp(), env: {} });
  c.update({ photos: { dailyCap: 20 } });
  assert.strictEqual(c.reset().photos.dailyCap, 5);
});
