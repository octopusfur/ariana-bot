"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createStickerChoices } = require("../sticker_choice");

test("nothing is chosen unless she fills in the sticker field", () => {
  const c = createStickerChoices();
  c.fromArgs("1", { message: "hi" });
  c.fromArgs("1", { message: "hi", sticker: "" });
  c.fromArgs("1", { message: "hi", sticker: "   " });
  c.fromArgs("1", { message: "hi", sticker: 5 });
  assert.strictEqual(c.take("1"), null);
});

test("her pick is remembered for that chat only, and used once", () => {
  const c = createStickerChoices();
  c.fromArgs("1", { message: "lol", sticker: "  eye   roll " });
  assert.strictEqual(c.take("2"), null);
  assert.strictEqual(c.take("1").mood, "eye roll");
  assert.strictEqual(c.take("1"), null);
});

test("a newer attempt without a sticker cancels an older attempt's pick", () => {
  const c = createStickerChoices();
  c.fromArgs("1", { sticker: "cheering" });
  c.fromArgs("1", { message: "second try, no sticker" });
  assert.strictEqual(c.take("1"), null);
});

test("a stale pick expires, and the mood is kept short", () => {
  let t = 1000;
  const c = createStickerChoices({ now: () => t });
  c.fromArgs("1", { sticker: "x".repeat(200) });
  assert.strictEqual(c.take("1").mood.length, 40);
  c.fromArgs("1", { sticker: "laugh" });
  t += 3 * 60 * 1000;
  assert.strictEqual(c.take("1"), null);
});
