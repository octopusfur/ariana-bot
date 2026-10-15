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

// ---- sending to someone else she knows --------------------------------------------------------------------------------
function makeWithTargets(env = {}) {
  let t = 5_000_000;
  const delivered = [];
  const people = { "Tola": { id: "2348011111111", name: "Tola" }, "Chidi": { id: "tg_555", name: "Chidi" } };
  const skill = createPhotoSkill({
    fetchRows: async () => ROWS, now: () => t, env,
    resolveTarget: async (raw) => people[raw] || null,
    deliver: async (id, url, caption) => { if (id === "tg_555" && env.TG_DOWN) throw new Error("telegram down"); delivered.push({ id, url, caption }); },
  });
  return { skill, delivered, advance: (ms) => { t += ms; } };
}

test("she can send a picture to someone else she knows; it goes out right away and the tool says so", async () => {
  const { skill, delivered } = makeWithTargets();
  assert.ok(skill.schema(await skill.snapshot()).function.parameters.properties.to);
  const r = await skill.execute("current-chat", { photo_id: "aaaaaa", to: "Tola", caption: "for you" });
  assert.strictEqual(r.ok, true);
  assert.match(r.note, /sent to Tola/);
  assert.deepStrictEqual(delivered, [{ id: "2348011111111", url: "https://x/a.jpg", caption: "for you" }]);
  assert.strictEqual(skill.take("current-chat"), null, "nothing extra is queued for the current chat");
});

test("strangers are refused and nothing is sent", async () => {
  const { skill, delivered } = makeWithTargets();
  const r = await skill.execute("c1", { photo_id: "aaaaaa", to: "Some Random Number" });
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /only send pictures to people you already talk to/);
  assert.strictEqual(delivered.length, 0);
});

test("sending to others has its own cooldown per person and a daily cap across everyone", async () => {
  const { skill, delivered, advance } = makeWithTargets({ PHOTO_OTHERS_DAILY_CAP: "2", PHOTO_COOLDOWN_MIN: "5" });
  assert.strictEqual((await skill.execute("c", { photo_id: "aaaaaa", to: "Tola" })).ok, true);
  assert.strictEqual((await skill.execute("c", { photo_id: "bbbbbb", to: "Tola" })).ok, false, "same person too soon");
  assert.strictEqual((await skill.execute("c", { photo_id: "aaaaaa", to: "Chidi" })).ok, true);
  advance(10 * 60 * 1000);
  const capped = await skill.execute("c", { photo_id: "bbbbbb", to: "Tola" });
  assert.strictEqual(capped.ok, false);
  assert.match(capped.note, /enough pictures to other people/);
  assert.strictEqual(delivered.length, 2);
});

test("a delivery failure is reported to her honestly and does not count against the limits", async () => {
  const { skill } = makeWithTargets({ TG_DOWN: "1" });
  const r = await skill.execute("c", { photo_id: "aaaaaa", to: "Chidi" });
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /didn't go through/);
});

test("without delivery wiring the 'to' option is not offered at all", async () => {
  const skill = createPhotoSkill({ fetchRows: async () => ROWS, env: {} });
  assert.strictEqual(skill.schema(await skill.snapshot()).function.parameters.properties.to, undefined);
});

// ---- dashboard controls ---------------------------------------------------------------------------------------------
test("dashboard limits apply instantly: switch off, cooldown, daily cap, send-to-others", async () => {
  let c = { enabled: true, cooldownMin: 0, dailyCap: 2, sendToOthers: true, othersDailyCap: 5 };
  const delivered = [];
  let t = 9_000_000;
  const skill = createPhotoSkill({ fetchRows: async () => ROWS, now: () => t, controls: () => c, resolveTarget: async () => ({ id: "x1", name: "Tola" }), deliver: async (id) => { delivered.push(id); } });
  assert.strictEqual((await skill.snapshot()).length, 2);
  assert.ok(skill.schema(await skill.snapshot()).function.parameters.properties.to);

  assert.strictEqual((await skill.execute("c1", { photo_id: "aaaaaa" })).ok, true); skill.take("c1");
  assert.strictEqual((await skill.execute("c1", { photo_id: "aaaaaa" })).ok, true); skill.take("c1");
  assert.strictEqual((await skill.execute("c1", { photo_id: "aaaaaa" })).ok, false, "daily cap of 2");
  c = { ...c, dailyCap: 10 };
  assert.strictEqual((await skill.execute("c1", { photo_id: "aaaaaa" })).ok, true, "raised cap takes effect at once"); skill.take("c1");

  c = { ...c, sendToOthers: false };
  assert.strictEqual(skill.schema(await skill.snapshot()).function.parameters.properties.to, undefined);
  const r = await skill.execute("c2", { photo_id: "aaaaaa", to: "Tola" });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(delivered, []);

  c = { ...c, enabled: false };
  assert.deepStrictEqual(await skill.snapshot(), [], "switched off: she is not even offered the library");
  assert.strictEqual(skill.enabled(), false);
});
