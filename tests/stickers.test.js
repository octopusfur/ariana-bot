"use strict";
const test = require("node:test");
const assert = require("node:assert");
const stickers = require("../stickers");

const rowsStore = [];
const fakeSupabase = { from: () => ({
  upsert: async (row) => { rowsStore.push(row); return {}; },
  select: () => ({ eq: async () => ({ data: rowsStore.map((r) => ({ key: r.key, data: r.data })) }) }),
}) };
const llm = (answer) => async () => ({ content: JSON.stringify(answer) });

test("a sticker is catalogued once, with a description, and saved", async () => {
  stickers.configure({ supabase: fakeSupabase, random: () => 0 });
  const e = await stickers.add({ base64: "AAAA", mimetype: "image/webp" }, { complete: llm({ label: "cat rolling its eyes", mood: "sarcastic, unimpressed" }), apiKey: "k" });
  assert.strictEqual(e.label, "cat rolling its eyes");
  await stickers.add({ base64: "AAAA" }, { complete: llm({ label: "other" }), apiKey: "k" });
  assert.strictEqual(stickers.size(), 1, "same sticker is not added twice");
  assert.strictEqual(rowsStore.length, 1);
  assert.strictEqual(rowsStore[0].type, "wa_sticker");
});

test("she follows up with a sticker only after a few replies, picks from the drawer, then cools down", async () => {
  const sent = [];
  const id = stickers.list()[0].id;
  const run = () => stickers.maybeFollowUp({ chat: "c1", userText: "you're lying", replyText: "obviously", send: async (s) => sent.push(s.id), deps: { complete: llm({ id }), apiKey: "k" } });
  for (let i = 0; i < 4; i++) assert.strictEqual(await run(), false, "too soon");
  assert.strictEqual(await run(), true);
  assert.deepStrictEqual(sent, [id]);
  assert.strictEqual(await run(), false, "cooldown restarts after one is sent");
});

test("when the model says none, or names an unknown sticker, nothing is sent", async () => {
  stickers._replies.set("c2", 10);
  assert.strictEqual(await stickers.choose({ userText: "x", replyText: "y" }, { complete: llm({ id: null }), apiKey: "k" }), null);
  assert.strictEqual(await stickers.choose({ userText: "x", replyText: "y" }, { complete: llm({ id: "nope" }), apiKey: "k" }), null);
});

test("the drawer reloads from Supabase after a restart", async () => {
  stickers._lib.clear();
  assert.strictEqual(await stickers.load(), 1);
});
