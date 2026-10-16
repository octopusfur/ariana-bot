"use strict";
const test = require("node:test");
const assert = require("node:assert");
const policy = require("../post_policy");
const { publish } = require("../story_publish");

const lib = (type) => ({ source: "library", type });

test("her own picture goes to status, Telegram, Snapchat story and Instagram (not Spotlight); her video to everything but Instagram", () => {
  assert.deepStrictEqual(policy.destinationsFor(lib("image")), ["whatsapp_status", "telegram_story", "snapchat_story", "instagram_post"]);
  assert.deepStrictEqual(policy.destinationsFor(lib("video")), ["whatsapp_status", "telegram_story", "snapchat_story", "snapchat_spotlight"]);
});

test("internet finds and owner-sent media only ever go to the WhatsApp status", () => {
  for (const source of ["internet", "owner"]) for (const type of ["image", "video"]) {
    assert.deepStrictEqual(policy.destinationsFor({ source, type }), ["whatsapp_status"], `${source} ${type}`);
  }
});

test("text goes only to the WhatsApp status", () => {
  assert.deepStrictEqual(policy.destinationsFor({ source: "text", type: "text" }), ["whatsapp_status"]);
});

test("unknown destinations and malformed items are refused", () => {
  assert.strictEqual(policy.isAllowed("tiktok", lib("image")), false);
  assert.strictEqual(policy.isAllowed("instagram_post", null), false);
  assert.throws(() => policy.assertAllowed("instagram_post", lib("video")), /policy/);
  assert.throws(() => policy.assertAllowed("telegram_story", { source: "internet", type: "image" }), /policy/);
});

const deps = (log, over = {}) => ({
  destinations: Object.fromEntries(policy.DESTINATIONS.map((d) => [d, async (it) => { log.push([d, it.source]); }])),
  enabled: () => true,
  ...over,
});

test("fan-out sends each item only where the policy allows", async () => {
  const log = [];
  await publish({ source: "internet", type: "image", id: 1 }, deps(log));
  assert.deepStrictEqual(log, [["whatsapp_status", "internet"]], "an internet meme never reaches Telegram/Instagram/Snapchat");
  log.length = 0;
  await publish({ source: "library", type: "image" }, deps(log));
  assert.deepStrictEqual(log.map((x) => x[0]), policy.destinationsFor(lib("image")));
});

test("switched-off destinations are skipped quietly; a failing mirror never blocks the others", async () => {
  const log = [];
  const d = deps(log, { enabled: (x) => x !== "telegram_story" });
  d.destinations.instagram_post = async () => { throw new Error("token expired"); };
  const r = await publish(lib("image"), d);
  assert.ok(!log.some((x) => x[0] === "telegram_story"));
  assert.ok(log.some((x) => x[0] === "snapchat_story"), "later destinations still ran");
  assert.deepStrictEqual(r.find((x) => x.dest === "instagram_post"), { dest: "instagram_post", ok: false, error: "token expired" });
});

test("if the WhatsApp status fails, nothing is mirrored", async () => {
  const log = [];
  const d = deps(log);
  d.destinations.whatsapp_status = async () => { throw new Error("not connected"); };
  const r = await publish(lib("image"), d);
  assert.strictEqual(log.length, 0);
  assert.strictEqual(r.length, 1);
});

test("unavailable destinations are reported honestly, never faked", async () => {
  const log = [];
  const r = await publish(lib("image"), deps(log, { unavailable: { snapchat_story: "no story support in the sidecar" } }), { only: ["snapchat_story"] });
  assert.deepStrictEqual(r, [{ dest: "snapchat_story", ok: false, skipped: "no story support in the sidecar" }]);
  assert.strictEqual(log.length, 0);
});

test("an explicit request for a destination the policy forbids is refused, not sent", async () => {
  const log = [];
  const r = await publish({ source: "internet", type: "image" }, deps(log), { only: ["instagram_post"] });
  assert.strictEqual(log.length, 0);
  assert.match(r[0].skipped, /not allowed/);
});
