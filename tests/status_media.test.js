"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fx = require("./helpers-media");
const sm = require("../status_media");
const ts = require("../telegram_story");

const skip = fx.hasFfmpeg ? false : "ffmpeg not installed";
const fakeHttp = (buf, type) => ({ get: async () => ({ data: buf, headers: { "content-type": type } }) });

test("a picture is downloaded, rotated, shrunk to JPEG", async () => {
  const big = await require("sharp")({ create: { width: 3000, height: 2000, channels: 3, background: "#a33" } }).png().toBuffer();
  const r = await sm.loadImage("https://x/a.png", { http: fakeHttp(big, "image/png") });
  assert.strictEqual(r.mimetype, "image/jpeg");
  const meta = await require("sharp")(r.buffer).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 1600);
  await assert.rejects(sm.loadImage("https://x/a.png", { http: fakeHttp(Buffer.from("not an image at all"), "text/html") }), /not a usable picture/);
  await assert.rejects(sm.loadImage("ftp://x/a.png"), /web address/);
});

test("a video is re-encoded to a small MP4 within the limits", { skip }, async () => {
  const r = await sm.prepareVideo(fx.mp4(4));
  assert.strictEqual(r.mimetype, "video/mp4");
  assert.ok(r.buffer.length < 4.5 * 1024 * 1024);
  assert.ok(r.durationSec > 3 && r.durationSec <= 30);
  assert.ok(r.width > 0 && r.height > 0);
  assert.strictEqual(r.buffer.toString("latin1", 4, 8), "ftyp");
  const v = await sm.loadVideo("https://x/v.mp4", { http: fakeHttp(fx.mp4(2), "video/mp4") });
  assert.ok(v.base64.length > 100);
});

test("long videos are cut to 30 seconds; garbage is refused", { skip }, async () => {
  const r = await sm.prepareVideo(fx.mp4(40));
  assert.ok(r.durationSec <= 30);
  await assert.rejects(sm.prepareVideo(Buffer.from("this is not a video, just some bytes that are long enough")), /not a readable video/);
});

// Telegram story: records the exact request that would be sent (no network)
const recording = () => {
  const calls = [];
  const client = { uploadFile: async (o) => ({ uploaded: o.file.name }), invoke: async (req) => { calls.push(req); return {}; } };
  return { client, calls };
};
test("Telegram story: a picture is sent as photo media; a video as a streaming video document", async () => {
  const { client, calls } = recording();
  await ts.postStory(client, { buffer: Buffer.from("jpegbytes"), caption: "hi", mimetype: "image/jpeg" });
  assert.strictEqual(calls[0].className, "stories.SendStory");
  assert.strictEqual(calls[0].media.className, "InputMediaUploadedPhoto");
  await ts.postStory(client, { buffer: Buffer.from("mp4bytes"), mimetype: "video/mp4", video: { duration: 7.4, width: 540, height: 960 } });
  const m = calls[1].media;
  assert.strictEqual(m.className, "InputMediaUploadedDocument");
  assert.strictEqual(m.mimeType, "video/mp4");
  assert.deepStrictEqual([m.attributes[0].duration, m.attributes[0].w, m.attributes[0].h, m.attributes[0].supportsStreaming], [7, 540, 960, true]);
  await assert.rejects(ts.postStory(null, { buffer: Buffer.from("x") }), /not connected/);
  await assert.rejects(ts.postStory(client, { buffer: Buffer.alloc(0) }), /no picture or video/);
});
