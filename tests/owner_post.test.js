"use strict";
const test = require("node:test");
const assert = require("node:assert");
const op = require("../owner_post");

test("the exact failing sentence from the chat is understood: 'post it to your status'", () => {
  const p = op.parse("I said post it to your status not send it to me");
  assert.ok(p);
  assert.strictEqual(p.what, "last");
  assert.deepStrictEqual(p.only, ["whatsapp_status"]);
});

test("natural variations parse", () => {
  const cases = [
    ["post that pic on your status", "last", ["whatsapp_status"]],
    ["put it on your status", "last", ["whatsapp_status"]],
    ["upload a gym pic to your status", "photo", ["whatsapp_status"]],
    ["post a funny gif on your status", "funny", ["whatsapp_status"]],
    ["post a video on your telegram story", "video", ["telegram_story"]],
    ["post that to your instagram", "last", ["instagram_post"]],
    ["post a video to your spotlight", "video", ["snapchat_spotlight"]],
    ["post it to your story", "last", ["telegram_story", "snapchat_story"]],
    ["post it to your status and instagram", "last", ["whatsapp_status", "instagram_post"]],
  ];
  for (const [text, what, only] of cases) {
    const p = op.parse(text);
    assert.ok(p, text);
    assert.strictEqual(p.what, what, text);
    assert.deepStrictEqual(p.only, only, text);
  }
});

test("tags words become the picture query; a caption can be given", () => {
  const p = op.parse("post a black set gym pic to your status saying leg day");
  assert.strictEqual(p.what, "photo");
  assert.match(p.query, /black set gym/);
  assert.strictEqual(p.caption, "leg day");
});

test("ordinary chat is not treated as a posting request", () => {
  for (const t of ["send me a pic", "what's on your status", "how are you", "I posted it yesterday", "post a status", "did you see my story", "send me a gym pic"]) {
    assert.strictEqual(op.parse(t), null, t);
  }
});

test("summaries say plainly what happened, including refusals and failures", () => {
  assert.strictEqual(op.summarize([{ dest: "whatsapp_status", ok: true }, { dest: "telegram_story", ok: true }]), "done, posted it to my WhatsApp status and my Telegram story");
  const s = op.summarize([{ dest: "whatsapp_status", ok: true }, { dest: "instagram_post", ok: false, skipped: "not set up" }, { dest: "snapchat_spotlight", ok: false, error: "Spotlight needs a vertical video" }]);
  assert.match(s, /done, posted it to my WhatsApp status/);
  assert.match(s, /Instagram: not set up/);
  assert.match(s, /Snapchat Spotlight: Spotlight needs a vertical video/);
  assert.match(op.summarize([{ dest: "instagram_post", ok: false, skipped: "not allowed: internet video" }]), /not allowed there/);
  assert.strictEqual(op.summarize([]), "nothing was posted");
});

test("pickPicture prefers the tag match", () => {
  const rows = [{ id: "a", url: "u/a", tags: ["beach"] }, { id: "b", url: "u/b", tags: ["gym", "black set"] }];
  assert.strictEqual(op.pickPicture(rows, "black set gym").id, "b");
});
