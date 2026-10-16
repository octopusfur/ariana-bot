"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { create } = require("../status_destinations");
const { publish } = require("../story_publish");

const mk = (over = {}) => {
  const log = [];
  const sw = { status: { telegramStory: true, instagram: true, snapchatStory: true, snapchatSpotlight: true }, ...(over.controls || {}) };
  const deps = {
    waWeb: async (p, b) => log.push(["wa", p, Object.keys(b).join(",")]),
    getTgClient: () => (over.noTelegram ? null : { id: "tg" }),
    telegramStory: { postStory: async (c, o) => log.push(["tg", o.mimetype]) },
    instagram: { isConfigured: () => !over.noInstagram, publishPhoto: async (o) => { log.push(["ig", o.imageUrl, o.caption]); return { id: "1" }; } },
    hostPublicJpeg: async () => ({ url: "https://tmp.example.com/a.jpg", remove: () => log.push(["ig-cleanup"]) }),
    snapchat: over.noSnap ? null : { isConfigured: () => true, postStory: async (u) => log.push(["snap-story", u]), postSpotlight: async (u, c) => log.push(["snap-spot", u, c]) },
    controls: () => sw,
  };
  const d = create(deps);
  const run = (item, opts) => publish(item, { destinations: Object.fromEntries(Object.entries(d.destinations()).filter(([, f]) => f)), enabled: d.enabled }, opts);
  return { log, run, d };
};
const img = { source: "library", type: "image", url: "https://cdn.x/a.jpg", payload: { text: "gym", base64: "QUJD", mimetype: "image/jpeg" } };
const vid = (v, url = "https://cdn.x/v.mp4") => ({ source: "library", type: "video", url, payload: { text: "hey", base64: "QUJD", mimetype: "video/mp4", video: v } });

test("her picture: WhatsApp status, Telegram story, Snapchat story and Instagram (hosted JPEG, then cleaned up); no Spotlight", async () => {
  const { log, run } = mk();
  const r = await run(img);
  assert.deepStrictEqual(log.map((x) => x[0]), ["wa", "tg", "snap-story", "ig", "ig-cleanup"]);
  assert.ok(r.every((x) => x.ok));
  assert.deepStrictEqual(log.find((x) => x[0] === "ig").slice(1), ["https://tmp.example.com/a.jpg", "gym"]);
  assert.strictEqual(log.find((x) => x[0] === "snap-story")[1], "https://cdn.x/a.jpg", "Snapchat gets her original library file");
});

test("her vertical 6-60 s video goes to Spotlight and Snapchat story, never Instagram", async () => {
  const { log, run } = mk();
  await run(vid({ duration: 12, sourceDuration: 40, width: 540, height: 960 }));
  assert.deepStrictEqual(log.map((x) => x[0]), ["wa", "tg", "snap-story", "snap-spot"]);
  assert.strictEqual(log.find((x) => x[0] === "tg")[1], "video/mp4");
  assert.deepStrictEqual(log.find((x) => x[0] === "snap-spot").slice(1), ["https://cdn.x/v.mp4", "hey"]);
});

test("Spotlight refuses a horizontal or too-short video with a plain reason, without blocking the rest", async () => {
  let m = mk();
  let r = await m.run(vid({ duration: 12, sourceDuration: 12, width: 1280, height: 720 }));
  assert.match(r.find((x) => x.dest === "snapchat_spotlight").error, /vertical/);
  assert.ok(r.find((x) => x.dest === "snapchat_story").ok, "the story still went out");
  m = mk(); r = await m.run(vid({ duration: 3, sourceDuration: 3, width: 540, height: 960 }));
  assert.match(r.find((x) => x.dest === "snapchat_spotlight").error, /6 and 60/);
});

test("Snapchat refuses file types it cannot take (e.g. .webp, .gif)", async () => {
  const { run } = mk();
  const r = await run({ ...img, url: "https://cdn.x/a.webp" });
  assert.match(r.find((x) => x.dest === "snapchat_story").error, /jpg or png/);
});

test("every dashboard switch is honoured, and un-set-up places are silently absent", async () => {
  const off = { status: { telegramStory: false, instagram: false, snapchatStory: false, snapchatSpotlight: false } };
  const a = mk({ controls: off });
  await a.run(img);
  assert.deepStrictEqual(a.log.map((x) => x[0]), ["wa"], "all mirrors switched off: WhatsApp only");
  const b = mk({ noTelegram: true, noInstagram: true, noSnap: true });
  await b.run(img);
  assert.deepStrictEqual(b.log.map((x) => x[0]), ["wa"]);
});

test("internet GIFs and owner-sent media only reach WhatsApp even with everything switched on", async () => {
  for (const source of ["internet", "owner"]) {
    const { log, run } = mk();
    await run({ source, type: "video", url: "https://cdn.x/v.mp4", payload: { base64: "QUJD", mimetype: "video/mp4", video: { width: 540, height: 960, duration: 10 } } });
    assert.deepStrictEqual(log.map((x) => x[0]), ["wa"], source);
  }
});

test("an explicit request for a place that is not set up says so", async () => {
  const { run } = mk({ noInstagram: true });
  const r = await run(img, { only: ["instagram_post"] });
  assert.deepStrictEqual(r, [{ dest: "instagram_post", ok: false, skipped: "not set up" }]);
});
