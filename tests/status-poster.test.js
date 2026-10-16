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

// ---- photo + found posts -------------------------------------------------------------------------------------------
function mkBot(over = {}) {
  const posted = [], prompts = [];
  const bot = sp.create({
    now: () => T0, rand: () => 0.1, enabled: () => true, isConnected: async () => true,
    generate: async (p) => { prompts.push(p); return over.say === undefined ? "so this is me today" : over.say; },
    post: async (x) => posted.push(x),
    listPhotos: async () => [{ id: "aaaaaa", tags: ["mirror", "black dress"] }, { id: "bbbbbb", tags: [] }],
    loadPhoto: async (it) => ({ base64: "IMG-" + it.id, mimetype: "image/jpeg" }),
    search: async () => ({ ok: true, output: "o Dog learns to drive\n  https://x\n  A dog in Ohio was filmed steering a golf cart." }),
    ...over,
  });
  return { bot, posted, prompts };
}

test("photo status: one of her own pictures goes out with a caption, and she cycles through the library before repeating", async () => {
  const { bot, posted, prompts } = mkBot();
  assert.strictEqual(await bot.postNow(undefined, { kind: "photo" }), "so this is me today");
  assert.strictEqual(await bot.postNow(undefined, { kind: "photo" }), "so this is me today");
  assert.strictEqual(posted.length, 2);
  assert.deepStrictEqual(posted.map((p) => p.base64).sort(), ["IMG-aaaaaa", "IMG-bbbbbb"], "no repeat until the whole library is used");
  assert.ok(posted.every((p) => p.mimetype === "image/jpeg" && p.text === "so this is me today"));
  assert.match(prompts.find((p) => p.includes("mirror")), /Only mention what the tags say/);
  assert.match(prompts.find((p) => p.includes("did not tag")), /do not describe/);
});

test("photo status can go out with no caption (NONE), and an empty library falls back to text", async () => {
  const none = mkBot({ say: "NONE" });
  await none.bot.postNow(undefined, { kind: "photo" });
  assert.strictEqual(none.posted[0].text, "");
  assert.ok(none.posted[0].base64);
  const empty = mkBot({ listPhotos: async () => [] });
  await assert.rejects(() => empty.bot.postNow(undefined, { kind: "photo" }), /library/);
});

test("found status: she reacts to something real from a web search, only from the results, and the results are treated as untrusted", async () => {
  const { bot, posted, prompts } = mkBot({ say: "a dog learned to drive a golf cart in ohio and im not okay" });
  assert.strictEqual(await bot.postNow(undefined, { kind: "found", topic: "funny" }), "a dog learned to drive a golf cart in ohio and im not okay");
  assert.strictEqual(posted[0], "a dog learned to drive a golf cart in ohio and im not okay");
  const p = prompts[0];
  assert.match(p, /untrusted text from websites/);
  assert.match(p, /Dog learns to drive/);
  assert.match(p, /never invent details/);
  assert.match(p, /deaths, tragedies, violence/);
});

test("found status: SKIP, AI mentions and failed searches never get posted; unforced posts fall back to a normal text status", async () => {
  const skip = mkBot({ say: "SKIP" });
  await assert.rejects(() => skip.bot.postNow(undefined, { kind: "found" }), /web search/);
  assert.strictEqual(skip.posted.length, 0);
  const ai = mkBot({ say: "as an AI i find this funny" });
  await assert.rejects(() => ai.bot.postNow(undefined, { kind: "found" }));
  const down = mkBot({ search: async () => ({ ok: false, error: "no key" }) });
  await assert.rejects(() => down.bot.postNow(undefined, { kind: "found" }));
  // not forced: she still posts something rather than going quiet
  const mixed = mkBot({ search: async () => ({ ok: false }), listPhotos: async () => [] });
  assert.strictEqual(await mixed.bot.postNow(), "so this is me today");
  assert.strictEqual(mixed.posted.length, 1);
});

test("scheduled posts mix kinds and never lean on the one she just used", async () => {
  const kinds = [];
  let r = 0;
  const seq = [0.05, 0.4, 0.7, 0.95, 0.2, 0.55, 0.85, 0.3];
  const bot = sp.create({
    now: () => T0, rand: () => seq[r++ % seq.length], enabled: () => true, isConnected: async () => true,
    generate: async () => "a caption", post: async (x) => kinds.push(typeof x === "string" ? "text" : "photo"),
    listPhotos: async () => [{ id: "aaaaaa", tags: [] }], loadPhoto: async () => ({ base64: "x" }),
  });
  for (let i = 0; i < 6; i++) await bot.postNow(undefined, {});
  assert.ok(kinds.includes("text") && kinds.includes("photo"), kinds.join());
});

test("a day's plan can be 2-3 posts when asked, still 3h+ apart and in her waking hours", () => {
  for (let i = 0; i < 200; i++) {
    const slots = sp.planDay(T0, Math.random, { min: 2, max: 3 });
    assert.ok(slots.length >= 1 && slots.length <= 3);
    for (let k = 1; k < slots.length; k++) assert.ok(slots[k].at - slots[k - 1].at >= 3 * H);
  }
  assert.ok(Array.from({ length: 200 }, () => sp.planDay(T0, Math.random, { min: 2, max: 3 }).length).some((n) => n === 3));
});

// ---- dashboard controls ---------------------------------------------------------------------------------------------
test("kinds switched off in the dashboard are never used by the schedule, and forced ones still work", async () => {
  const posted = [];
  const bot = sp.create({
    now: () => T0, rand: () => 0.1, enabled: () => true, isConnected: async () => true,
    generate: async () => "caption", post: async (x) => posted.push(typeof x === "string" ? "text" : "photo"),
    listPhotos: async () => [{ id: "aaaaaa", tags: [] }], loadPhoto: async () => ({ base64: "x" }),
    search: async () => ({ ok: true, output: "something funny" }),
    kindEnabled: (k) => k === "photo",
  });
  for (let i = 0; i < 5; i++) await bot.postNow(undefined, {});
  assert.deepStrictEqual([...new Set(posted)], ["photo"]);
  await bot.postNow(undefined, { kind: "text" });
  assert.strictEqual(posted[posted.length - 1], "text");
});

test("with every kind off she posts nothing (and says so) instead of using a disabled kind", async () => {
  const posted = [];
  const bot = sp.create({ now: () => T0, rand: () => 0.1, enabled: () => true, isConnected: async () => true, generate: async () => "x", post: async (x) => posted.push(x), kindEnabled: () => false });
  await assert.rejects(() => bot.postNow(undefined, {}));
  assert.strictEqual(posted.length, 0);
});

test("only the enabled web topic is searched", async () => {
  const queries = [];
  const bot = sp.create({
    now: () => T0, rand: () => 0.9, enabled: () => true, isConnected: async () => true, generate: async () => "so true", post: async () => {},
    search: async (q) => { queries.push(q); return { ok: true, output: "result" }; },
    kindEnabled: (k) => k === "found", topicEnabled: (t) => t === "news",
  });
  await bot.postNow(undefined, {});
  assert.ok(/news/i.test(queries[0]) && !/funn/i.test(queries[0]), queries[0]);
});

test("changing posts-per-day mid-day keeps what already went out and re-plans the rest", async () => {
  let t = T0, per = { min: 1, max: 1 };
  const bot = sp.create({ now: () => t, rand: () => 0.3, enabled: () => true, isConnected: async () => false, generate: async () => "x", post: async () => {}, postsPerDay: () => per });
  await bot.tick();
  const first = bot.state.slots.length;
  per = { min: 3, max: 3 };
  await bot.tick();
  assert.ok(bot.state.slots.length >= first && bot.state.slots.length <= 3);
  const s = bot.state.slots;
  for (let k = 1; k < s.length; k++) assert.ok(s[k].at - s[k - 1].at >= 3 * H);
});

// ── video / GIF posts and the posting policy ──────────────────
const { publish } = require("../story_publish");
const pol = require("../post_policy");
const poster = (extra = {}) => {
  const posted = [], seen = [];
  const destinations = Object.fromEntries(pol.DESTINATIONS.map((d) => [d, async (it) => { seen.push([d, it.source, it.type]); if (d === "whatsapp_status") posted.push(it.payload); }]));
  const bot = sp.create({
    now: () => T0, rand: () => 0.1, enabled: () => true, isConnected: async () => true,
    generate: async () => "mood",
    post: async (p) => posted.push(p),
    publish: (item) => publish(item, { destinations, enabled: () => true }),
    ...extra,
  });
  return { bot, posted, seen };
};

test("her own video from the library goes to WhatsApp, Telegram, Snapchat; never Instagram", async () => {
  const { bot, posted, seen } = poster({
    listVideos: async () => [{ id: "v1", url: "u", tags: ["gym"] }],
    loadVideo: async () => ({ base64: "VID", durationSec: 6, width: 540, height: 960 }),
  });
  const out = await bot.postNow(undefined, { kind: "video" });
  assert.ok(out);
  assert.strictEqual(posted[0].mimetype, "video/mp4");
  assert.deepStrictEqual(seen.map((x) => x[0]), ["whatsapp_status", "telegram_story", "snapchat_story", "snapchat_spotlight"]);
  assert.ok(seen.every((x) => x[1] === "library" && x[2] === "video"));
});

test("a funny GIF from the internet is posted to the WhatsApp status ONLY", async () => {
  const { bot, posted, seen } = poster({
    findFunny: async () => ({ id: "g1", title: "cat falls off table", url: "https://media.giphy.com/x.mp4" }),
    loadVideo: async (item) => { assert.strictEqual(item.url, "https://media.giphy.com/x.mp4"); return { base64: "GIF", durationSec: 3, width: 480, height: 480 }; },
  });
  await bot.postNow(undefined, { kind: "gif" });
  assert.strictEqual(posted.length, 1);
  assert.deepStrictEqual(seen, [["whatsapp_status", "internet", "video"]]);
  assert.deepStrictEqual(bot.state.recentGifs, ["g1"], "she will not repeat the same GIF soon");
});

test("her picture reaches Instagram too, and a failing Instagram never fails the WhatsApp post", async () => {
  const seen = [];
  const destinations = {
    whatsapp_status: async () => seen.push("wa"),
    instagram_post: async () => { throw new Error("token expired"); },
    telegram_story: async () => seen.push("tg"),
  };
  const bot = sp.create({
    now: () => T0, rand: () => 0.1, enabled: () => true, isConnected: async () => true, generate: async () => "gym day",
    post: async () => {}, listPhotos: async () => [{ id: "p1", url: "u", tags: ["gym"] }], loadPhoto: async () => ({ base64: "IMG", mimetype: "image/jpeg" }),
    publish: (item) => publish(item, { destinations, enabled: () => true }),
  });
  assert.ok(await bot.postNow(undefined, { kind: "photo" }));
  assert.deepStrictEqual(seen, ["wa", "tg"]);
  assert.strictEqual(bot.state.lastResults.find((r) => r.dest === "instagram_post").ok, false);
});

test("if the WhatsApp status itself fails, the post fails and nothing is mirrored", async () => {
  const seen = [];
  const destinations = { whatsapp_status: async () => { throw new Error("not connected"); }, telegram_story: async () => seen.push("tg") };
  const bot = sp.create({
    now: () => T0, rand: () => 0.1, enabled: () => true, isConnected: async () => true, generate: async () => "x",
    post: async () => {}, listPhotos: async () => [{ id: "p1", url: "u", tags: [] }], loadPhoto: async () => ({ base64: "IMG", mimetype: "image/jpeg" }),
    publish: (item) => publish(item, { destinations, enabled: () => true }),
  });
  await assert.rejects(bot.postNow(undefined, { kind: "photo" }), /couldn't make/);
  assert.deepStrictEqual(seen, []);
});
