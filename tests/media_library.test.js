"use strict";
const test = require("node:test");
const assert = require("node:assert");
const ml = require("../media_library");

test("tags are normalised: lowercase, trimmed, deduped, capped", () => {
  assert.deepStrictEqual(ml.normalizeTags("Gym,  Black Set , gym; mirror selfie\nOutdoor"), ["gym", "black set", "mirror selfie", "outdoor"]);
  assert.deepStrictEqual(ml.normalizeTags(["Beach", "BEACH", "  ", null]), ["beach"]);
  assert.strictEqual(ml.normalizeTags(Array.from({ length: 30 }, (_, i) => "t" + i)).length, 12);
  assert.deepStrictEqual(ml.normalizeTags(undefined), []);
  assert.ok(ml.normalizeTags("x".repeat(200))[0].length <= 40);
});

const rows = [
  { id: "a", url: "u/a", tags: ["gym", "black set", "mirror selfie"] },
  { id: "b", url: "u/b", tags: ["beach", "sunset", "bikini"] },
  { id: "c", url: "u/c", tags: [] },
  { id: "d", url: "", tags: ["gym"] },
];

test("picks the photo whose tags match the request", () => {
  assert.strictEqual(ml.pickBest(rows, "send me a gym pic", { rand: () => 0 }).id, "a");
  assert.strictEqual(ml.pickBest(rows, "show me a pic from the beach", { rand: () => 0 }).id, "b");
  assert.strictEqual(ml.pickBest(rows, "let me see your black set").id, "a");
});

test("no match: random, avoids what she sent this person recently, skips rows without a url", () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(ml.pickBest(rows, "send me a pic", { recentIds: ["a", "b"] }).id);
  assert.deepStrictEqual([...seen], ["c"], "only the unseen photo (never the url-less one)");
  assert.strictEqual(ml.pickBest([], "x"), null);
  assert.ok(ml.pickBest(rows, "send me a pic", { recentIds: ["a", "b", "c"] }), "falls back to repeats when everything was sent recently");
});

test("what she is told: tags when present, honesty when untagged", () => {
  assert.match(ml.describe(rows[0]), /tagged: gym, black set, mirror selfie/);
  assert.match(ml.describe(rows[2]), /not been tagged/);
  assert.match(ml.describe(rows[2]), /do not describe its contents/);
});

test("recent-sent memory is per conversation and bounded", () => {
  for (let i = 0; i < 8; i++) ml.rememberSent("chat1", "p" + i);
  assert.deepStrictEqual(ml.recentFor("chat1"), ["p3", "p4", "p5", "p6", "p7"]);
  assert.deepStrictEqual(ml.recentFor("chat2"), []);
});

test("auto-tag sends the photo to Luna as an image and cleans the tags; failures return []", async () => {
  let call;
  const complete = async (a) => { call = a; return { content: 'sure {"tags":["Gym","Black Set","gym"]}' }; };
  assert.deepStrictEqual(await ml.autoTag("https://x/y.jpg", { complete, apiKey: "k" }), ["gym", "black set"]);
  const part = call.history[0].content.find((p) => p.type === "image_url");
  assert.strictEqual(part.image_url.url, "https://x/y.jpg");
  assert.deepStrictEqual(await ml.autoTag("https://x/y.jpg", { complete: async () => { throw new Error("boom"); }, apiKey: "k" }), []);
  assert.deepStrictEqual(await ml.autoTag("https://x/y.jpg", { complete, apiKey: "" }), []);
  assert.deepStrictEqual(await ml.autoTag("https://x/y.jpg", { complete: async () => ({ content: "no json" }), apiKey: "k" }), []);
});
