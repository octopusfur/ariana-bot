"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createPhotoSkill, looksLikePhotoRequest } = require("../photo_skill");

const ROWS = [
  { id: "aaaaaa11-0000", url: "https://x/a.jpg", media_type: "selfie", tags: ["mirror", "black dress"] },
  { id: "bbbbbb22-0000", url: "https://x/b.jpg", media_type: "image", tags: "[\"butterfly dress\"]" },
  { id: "cccccc33-0000", url: "https://x/c.mp4", media_type: "video", tags: [] },
  { id: "dddddd44-0000", url: "", media_type: "image", tags: [] },
];
function make(extra = {}, env = {}) {
  let t = 1_000_000;
  const skill = createPhotoSkill({ fetchRows: async () => extra.rows || ROWS, now: () => t, env });
  return { skill, advance: (ms) => { t += ms; } };
}

test("only real, non-video pictures are offered, with their tags", async () => {
  const { skill } = make();
  const items = await skill.snapshot();
  assert.deepStrictEqual(items.map((i) => i.id), ["aaaaaa", "bbbbbb"]);
  assert.deepStrictEqual(items[1].tags, ["butterfly dress"]);
  assert.match(skill.promptNote(items), /YOUR choice/i);
  assert.deepStrictEqual(skill.schema(items).function.parameters.properties.photo_id.enum, ["aaaaaa", "bbbbbb"]);
});

test("she queues a picture only when she calls the tool, and it is delivered once", async () => {
  const { skill } = make();
  assert.strictEqual(skill.take("c1"), null);
  const r = await skill.execute("c1", { photo_id: "aaaaaa", caption: "  here  " });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual({ url: skill.take("c1").url }, { url: "https://x/a.jpg" });
  assert.strictEqual(skill.take("c1"), null);
});

test("unknown id and videos are refused", async () => {
  const { skill } = make();
  assert.strictEqual((await skill.execute("c1", { photo_id: "cccccc" })).ok, false);
  assert.strictEqual((await skill.execute("c1", { photo_id: "nope" })).ok, false);
  assert.strictEqual(skill.take("c1"), null);
});

test("cooldown and daily cap protect the library", async () => {
  const { skill, advance } = make({}, { PHOTO_COOLDOWN_MIN: "5", PHOTO_DAILY_CAP: "2" });
  assert.strictEqual((await skill.execute("c1", { photo_id: "aaaaaa" })).ok, true); skill.take("c1");
  assert.strictEqual((await skill.execute("c1", { photo_id: "bbbbbb" })).ok, false); // too soon
  advance(6 * 60 * 1000);
  assert.strictEqual((await skill.execute("c1", { photo_id: "bbbbbb" })).ok, true); skill.take("c1");
  advance(6 * 60 * 1000);
  const capped = await skill.execute("c1", { photo_id: "aaaaaa" });
  assert.strictEqual(capped.ok, false);
  assert.match(capped.note, /plenty|enough/i);
  assert.strictEqual((await skill.execute("other", { photo_id: "aaaaaa" })).ok, true); // other chats unaffected
});

test("an empty library offers nothing", async () => {
  const { skill } = make({ rows: [] });
  assert.deepStrictEqual(await skill.snapshot(), []);
});

test("a failing library fetch never throws into the chat", async () => {
  const skill = createPhotoSkill({ fetchRows: async () => { throw new Error("db down"); }, env: {} });
  assert.deepStrictEqual(await skill.snapshot(), []);
});

test("recognises people asking to see her, not people sharing their own photo", () => {
  for (const m of ["send me a pic", "can i see your face", "show me yourself", "what do u look like", "got any selfies?", "send photo abeg"]) assert.ok(looksLikePhotoRequest(m), m);
  for (const m of ["[sent a photo]", "[image: my dog]", "good morning", "how was your day", ""]) assert.ok(!looksLikePhotoRequest(m), m);
});
