"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STATE_SYNC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sp-"));
const sp = require("../status_poster");

const H = 3600000;
const T0 = Date.UTC(2026, 9, 13, 15, 0); // 11:00 in New York

test("a day's plan is 1–2 future posts, inside her waking hours, at least 3h apart", () => {
  for (let i = 0; i < 200; i++) {
    const slots = sp.planDay(T0);
    assert.ok(slots.length >= 1 && slots.length <= 2);
    for (const s of slots) { assert.ok(s.at > T0); const h = sp.nyHour(s.at); assert.ok(h >= 10 && h < 21, `hour ${h}`); }
    if (slots.length === 2) assert.ok(slots[1].at - slots[0].at >= 3 * H);
  }
  assert.deepStrictEqual(sp.planDay(Date.UTC(2026, 9, 13, 2, 0) + 20 * H, () => 0.5).filter((s) => sp.nyHour(s.at) < 10), []);
});

test("she posts when a slot is due and WhatsApp is connected, once, in her own words", async () => {
  let clock = T0, connected = true;
  const posted = [];
  const bot = sp.create({
    now: () => clock, rand: () => 0.1, // 2 posts, early picks
    enabled: () => true,
    isConnected: async () => connected,
    generate: async () => '"coffee number two and it is not even noon"',
    post: async (t) => posted.push(t),
  });
  assert.strictEqual(await bot.tick(), false, "nothing due yet, plan made");
  assert.ok(bot.state.slots.length >= 1);
  clock = bot.state.slots[0].at + 1000;
  connected = false;
  assert.strictEqual(await bot.tick(), false, "waits while disconnected");
  assert.strictEqual(posted.length, 0);
  connected = true;
  assert.strictEqual(await bot.tick(), true);
  assert.deepStrictEqual(posted, ["coffee number two and it is not even noon"], "quotes stripped");
  assert.strictEqual(await bot.tick(), false, "same slot is never posted twice");
  assert.strictEqual(posted.length, 1);
});

test("unusable text is never posted (AI mention, too long, empty) and the switch turns it off", async () => {
  assert.strictEqual(sp.clean("as an AI i cannot"), null);
  assert.strictEqual(sp.clean("x".repeat(200)), null);
  assert.strictEqual(sp.clean("  "), null);
  assert.strictEqual(sp.clean("so tired \u2014 send coffee"), "so tired, send coffee");
  const posted = [];
  const off = sp.create({ now: () => T0, enabled: () => false, isConnected: async () => true, generate: async () => "hi", post: async (t) => posted.push(t) });
  assert.strictEqual(await off.tick(), false);
  assert.strictEqual(posted.length, 0);
});

test("manual post uses the text given, or writes one", async () => {
  const posted = [];
  const bot = sp.create({ now: () => T0, enabled: () => true, isConnected: async () => true, generate: async () => "writing my own", post: async (t) => posted.push(t) });
  assert.strictEqual(await bot.postNow("hello world"), "hello world");
  assert.strictEqual(await bot.postNow(), "writing my own");
  assert.deepStrictEqual(posted, ["hello world", "writing my own"]);
});
