"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { postStory } = require("../telegram_story");

class Fake { constructor(a) { Object.assign(this, a); } }
const lib = {
  Api: { stories: { SendStory: class extends Fake {} }, InputPeerSelf: class extends Fake {}, InputMediaUploadedPhoto: class extends Fake {}, InputPrivacyValueAllowContacts: class extends Fake {} },
  CustomFile: class { constructor(name, size, path, buffer) { this.name = name; this.size = size; this.buffer = buffer; } },
  bigInt: Object.assign((n) => ({ multiply: () => ({ add: () => n }) }), {}),
};

test("a picture becomes a 24h Telegram story with a caption, for her contacts", async () => {
  let uploaded, sent;
  const client = { uploadFile: async (o) => { uploaded = o; return { id: "F1" }; }, invoke: async (req) => { sent = req; return { ok: true }; } };
  await postStory(client, { buffer: Buffer.from("jpgbytes"), caption: "x".repeat(300), lib });
  assert.strictEqual(uploaded.file.name, "story.jpg");
  assert.ok(sent instanceof lib.Api.stories.SendStory);
  assert.ok(sent.peer instanceof lib.Api.InputPeerSelf);
  assert.ok(sent.media instanceof lib.Api.InputMediaUploadedPhoto && sent.media.file.id === "F1");
  assert.ok(sent.privacyRules[0] instanceof lib.Api.InputPrivacyValueAllowContacts);
  assert.strictEqual(sent.period, 86400);
  assert.strictEqual(sent.caption.length, 200);
});

test("not connected / nothing to post are clear errors", async () => {
  await assert.rejects(() => postStory(null, { buffer: Buffer.from("x"), lib }), /not connected/);
  await assert.rejects(() => postStory({}, { buffer: Buffer.alloc(0), lib }), /no picture/);
});
