"use strict";
const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const media = require("../media");
const openai = require("../llm_openai");
const fx = require("./helpers-media");

const b64 = (b) => b.toString("base64");
const skip = fx.hasFfmpeg ? false : "ffmpeg not installed";

test("1. a photo with no caption becomes one real JPEG for the vision model", async () => {
  const r = await media.prepare({ kind: "image", base64: b64(await fx.jpeg(220, 30, 30)) });
  assert.ok(r.ok);
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].mimetype, "image/jpeg");
  const [R, G, B] = await fx.meanColour(r.images[0].base64);
  assert.ok(R > 150 && G < 90 && B < 90, "the actual pixels (red) reach the model");
});

test("2. a caption is kept next to the image in the same user turn", async () => {
  const r = await media.prepare({ kind: "image", base64: b64(await fx.png()), caption: "guess who" });
  const content = media.buildUserContent("guess who", r);
  assert.ok(Array.isArray(content));
  assert.ok(content[0].text.startsWith("guess who"));
  assert.strictEqual(content.filter((p) => p.type === "image_url").length, 1);
  assert.ok(content[1].image_url.url.startsWith("data:image/jpeg;base64,"));
});

test("3. a static sticker's real image (not a description) is what is sent", async () => {
  const r = await media.prepare({ kind: "sticker", base64: b64(await fx.staticWebp(20, 200, 20)) });
  assert.ok(r.ok && r.images.length === 1);
  const [R, G] = await fx.meanColour(r.images[0].base64);
  assert.ok(G > 150 && R < 90, "green sticker pixels reach the model");
  assert.match(r.note, /sticker/);
});

test("4. an animated sticker yields ordered frames that really differ", { skip }, async () => {
  const r = await media.prepare({ kind: "animation", label: "animated sticker", base64: b64(await fx.animatedWebp()) });
  assert.ok(r.ok);
  assert.ok(r.images.length >= 3, `got ${r.images.length}`);
  const times = r.images.map((f) => f.tMs);
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), "frames are in time order");
  const first = await fx.meanColour(r.images[0].base64), last = await fx.meanColour(r.images[r.images.length - 1].base64);
  assert.ok(first[0] > 150 && first[2] < 90, "starts red");
  assert.ok(last[2] > 150 && last[0] < 90, "ends blue");
  assert.match(r.note, /animated sticker/);
  assert.match(r.note, /frame 1 at 0\.0s/);
});

test("5. a GIF with real changes: frames are sampled across it, capped, and timed", { skip }, async () => {
  const r = await media.prepare({ kind: "animation", gif: true, label: "GIF", base64: b64(fx.colourGif()) });
  assert.ok(r.ok && r.images.length >= 3);
  const cols = await Promise.all(r.images.map((f) => fx.meanColour(f.base64)));
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  assert.ok(dist(cols[0], cols[cols.length - 1]) > 200, "first and last frame are visibly different");
  const long = await media.prepare({ kind: "animation", gif: true, base64: b64(fx.longGif(60)) });
  assert.ok(long.ok && long.images.length <= media.cfg().maxFrames, "frame count is capped to bound cost");
  assert.ok(long.durationMs > 0);
});

test("5b. an MP4 'GIF' (how WhatsApp ships GIFs) is sampled with ffmpeg", { skip }, async () => {
  const r = await media.prepare({ kind: "animation", gif: true, label: "GIF", base64: b64(fx.mp4(3)) });
  assert.ok(r.ok);
  assert.strictEqual(r.images.length, media.cfg().maxFrames);
  assert.ok(r.images[0].tMs < r.images[r.images.length - 1].tMs);
});

test("10. corrupted, unsupported, oversized and failed-download media fail honestly", async () => {
  const junk = b64(Buffer.from("this is definitely not an image, but long enough to pass length checks"));
  for (const kind of ["image", "sticker", "animation"]) {
    const r = await media.prepare({ kind, base64: junk });
    assert.strictEqual(r.ok, false, kind);
    assert.deepStrictEqual(r.images, []);
    assert.match(r.note, /did NOT see or hear/);
  }
  const truncated = (await fx.staticWebp()).subarray(0, 40);
  assert.strictEqual((await media.prepare({ kind: "image", base64: b64(Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), truncated.subarray(12)])) })).ok, false);
  assert.strictEqual((await media.prepare({ kind: "image", base64: b64(Buffer.alloc(9e6, 0xff)) })).error, "too large");
  const dl = await media.prepare({ kind: "audio", error: "download timed out" });
  assert.strictEqual(dl.ok, false);
  assert.match(dl.note, /voice note/);
  assert.strictEqual((await media.prepare({ kind: "image" })).ok, false, "no bytes at all");
  const notAudio = await media.prepare({ kind: "audio", base64: b64(await fx.jpeg()) }, { env: { OPENAI_API_KEY: "k" } });
  assert.strictEqual(notAudio.ok, false);
});

const okPost = (text, extra = {}) => async () => ({ text, ...extra });

test("8. a voice note is transcribed (OGG/Opus sent as-is) and the transcript is what Luna gets", { skip }, async () => {
  const calls = [];
  const post = async (url, form, headers) => { calls.push({ url, form, headers }); return { text: "hey, are we still on for tonight?" }; };
  const r = await media.prepare({ kind: "audio", base64: b64(fx.oggVoice()) }, { post, env: { OPENAI_API_KEY: "sk-test" } });
  assert.ok(r.ok);
  assert.strictEqual(r.transcript, "hey, are we still on for tonight?");
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /\/audio\/transcriptions$/);
  assert.strictEqual(calls[0].headers.Authorization, "Bearer sk-test");
  assert.strictEqual(calls[0].form.get("model"), "gpt-4o-transcribe");
  assert.strictEqual(calls[0].form.get("file").name, "voice.ogg", "no conversion needed for WhatsApp OGG/Opus");
  assert.deepStrictEqual(r.images, []);
  assert.match(r.note, /cannot convey tone/);
});

test("9. Pidgin / slang is passed through verbatim; the prompt asks for no formalising; uncertainty is explicit", { skip }, async () => {
  const pidgin = "Abeg wetin dey happen, I no fit come today o, na work dey worry me";
  let form;
  const post = async (_u, f) => { form = f; return { text: pidgin }; };
  const r = await media.prepare({ kind: "audio", base64: b64(fx.oggVoice()) }, { post, env: { OPENAI_API_KEY: "k" } });
  assert.strictEqual(r.transcript, pidgin, "wording is not rewritten");
  assert.match(form.get("prompt"), /Pidgin/);
  assert.match(form.get("prompt"), /do not translate, formalise or correct/i);
  const unclear = await media.prepare({ kind: "audio", base64: b64(fx.oggVoice()) }, { post: okPost("I go [unclear] tomorrow"), env: { OPENAI_API_KEY: "k" } });
  assert.strictEqual(unclear.uncertain, true);
  assert.match(unclear.note, /do not invent the missing words/);
  const lowConf = await media.prepare({ kind: "audio", base64: b64(fx.oggVoice()) }, {
    post: okPost("mm hmm", { segments: [{ avg_logprob: -1.6, no_speech_prob: 0.2 }] }), env: { OPENAI_API_KEY: "k", OPENAI_TRANSCRIBE_MODEL: "whisper-1" } });
  assert.strictEqual(lowConf.uncertain, true, "low-confidence segments are flagged");
  const silent = await media.prepare({ kind: "audio", base64: b64(fx.oggVoice()) }, { post: okPost("   "), env: { OPENAI_API_KEY: "k" } });
  assert.ok(silent.ok && silent.transcript === "");
  assert.match(silent.note, /do not guess/);
});

test("8b. transcription falls back to Groq when OpenAI fails; with no provider it fails honestly", { skip }, async () => {
  const urls = [];
  const post = async (url) => { urls.push(url); if (url.includes("api.openai.com")) throw new Error("500 down"); return { text: "from groq" }; };
  const r = await media.prepare({ kind: "audio", base64: b64(fx.oggVoice()) }, { post, env: { OPENAI_API_KEY: "a", GROQ_API_KEY: "b" } });
  assert.strictEqual(r.transcript, "from groq");
  assert.strictEqual(urls.length, 2);
  const none = await media.prepare({ kind: "audio", base64: b64(fx.oggVoice()) }, { env: {} });
  assert.strictEqual(none.ok, false);
  assert.match(none.note, /You did NOT see or hear/);
});

test("image parts map to the Responses API input_image shape; Groq fallback gets words only", async () => {
  const content = media.buildUserContent("look", { ok: true, note: "n", images: [{ base64: "AAAA", mimetype: "image/jpeg" }, { base64: "BBBB", mimetype: "image/jpeg" }] });
  const input = openai.toInput([{ role: "user", content }]);
  const parts = input[0].content;
  assert.strictEqual(parts[0].type, "input_text");
  assert.deepStrictEqual(parts.slice(1).map((p) => [p.type, p.detail]), [["input_image", "low"], ["input_image", "low"]]);
  assert.match(parts[1].image_url, /^data:image\/jpeg;base64,AAAA$/);
  const flat = media.flattenContent(content);
  assert.strictEqual(typeof flat, "string");
  assert.match(flat, /2 image\(s\) were attached/);
  assert.ok(!flat.includes("AAAA"));
});

test("13. text-only turns are untouched by the media code", () => {
  assert.strictEqual(media.buildUserContent("hello", null), "hello");
  assert.strictEqual(media.flattenContent("plain"), "plain");
  assert.deepStrictEqual(openai.toInput([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
});
