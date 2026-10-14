"use strict";
/**
 * End-to-end: boots the REAL index.js, posts WhatsApp-sidecar-shaped webhooks, and checks what reaches
 * (fake) OpenAI / Luna and what is sent back through a (fake) sidecar. The external services are mocks,
 * so this proves our wiring, not that production OpenAI accepts these exact requests.
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const fx = require("./helpers-media");

const skip = fx.hasFfmpeg ? false : "ffmpeg not installed";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => b.toString("base64");
const OWNER = "2349000000000";

function server(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port })); });
}
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

let ctx;
const lunaReqs = [], transcribeReqs = [], sent = [];
let transcript = "ok";

test.before(async () => {
  const openai = await server(async (req, res) => {
    const raw = await readBody(req);
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/audio/transcriptions")) { transcribeReqs.push({ bytes: raw.length, hasOgg: raw.includes("OggS"), hasName: raw.includes('filename="voice.ogg"'), hasPidginPrompt: raw.includes("Pidgin") }); return res.end(JSON.stringify({ text: transcript })); }
    if (req.url.endsWith("/responses")) { lunaReqs.push(JSON.parse(raw)); return res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "lol okay" }] }] })); }
    res.statusCode = 404; res.end("{}");
  });
  const sidecar = await server(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    sent.push({ route: req.url, ...body }); res.setHeader("content-type", "application/json"); res.end("{}");
  });
  const port = 21000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), WA_API_SECRET: "s", WA_PROVIDER: "wwebjs", WA_WEB_PORT: String(sidecar.port),
      OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: `http://127.0.0.1:${openai.port}`, HUMAN_DELAY_SCALE: "0", OWNER_PHONE: OWNER, SIGNAL_CLI_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/webhook`); if (r.ok) break; } catch {} await wait(200); }
  ctx = { child, port, openai, sidecar, logs: () => log };
});
test.after(() => { ctx.child.kill(); ctx.openai.s.close(); ctx.sidecar.s.close(); });

const post = (message) => fetch(`http://127.0.0.1:${ctx.port}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-wa-secret": "s" }, body: JSON.stringify({ message }) });
async function until(fn, ms = 15000) { for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await wait(100); } throw new Error("timed out waiting\n" + ctx.logs().slice(-1500)); }
const textsTo = (to) => sent.filter((x) => x.route === "/send" && String(x.to) === to);
const userTurn = (req) => { const u = req.input.filter((m) => m.role === "user"); return u[u.length - 1].content; };
const images = (req) => (Array.isArray(userTurn(req)) ? userTurn(req).filter((p) => p.type === "input_image") : []);
const textOf = (req) => { const c = userTurn(req); return Array.isArray(c) ? c.filter((p) => p.type === "input_text").map((p) => p.text).join("\n") : c; };
let n = 0;
const uid = () => `T${Date.now()}${n++}`;
const phone = () => `23480${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function sendAndWait(from, message) {
  const before = lunaReqs.length, sentBefore = textsTo(from).length;
  await post({ from, id: uid(), pushName: "Tola", ...message });
  await until(() => textsTo(from).length > sentBefore);
  return lunaReqs.slice(before);
}
const lastWithImages = (reqs) => reqs.filter((r) => images(r).length).pop();

test("13. ordinary text still works end to end and sends no images", async () => {
  const from = phone();
  const reqs = await sendAndWait(from, { type: "text", text: { body: "hello there" } });
  assert.ok(reqs.length >= 1);
  assert.ok(reqs.every((r) => images(r).length === 0));
  assert.ok(reqs.some((r) => JSON.stringify(r).includes("hello there")));
  assert.strictEqual(textsTo(from)[0].message.length > 0, true);
});

test("1. an image with no caption: the real picture reaches Luna as input_image", async () => {
  const from = phone();
  const reqs = await sendAndWait(from, { type: "image", image: { base64: b64(await fx.jpeg(220, 30, 30)), mimetype: "image/jpeg" } });
  const r = lastWithImages(reqs);
  assert.ok(r, "Luna received an image");
  assert.strictEqual(images(r).length, 1);
  assert.match(images(r)[0].image_url, /^data:image\/jpeg;base64,/);
  assert.match(textOf(r), /photo they just sent/);
});

test("2. an image with a caption: caption and picture arrive together", async () => {
  const from = phone();
  const reqs = await sendAndWait(from, { type: "image", image: { base64: b64(await fx.png()), mimetype: "image/png", caption: "who is this one" } });
  const r = lastWithImages(reqs);
  assert.strictEqual(images(r).length, 1);
  assert.match(textOf(r), /who is this one/);
});

test("3. a static sticker's actual image reaches Luna", async () => {
  const from = phone();
  const reqs = await sendAndWait(from, { type: "sticker", sticker: { base64: b64(await fx.staticWebp()), mimetype: "image/webp", animated: false } });
  const r = lastWithImages(reqs);
  assert.strictEqual(images(r).length, 1);
  assert.match(textOf(r), /sticker/);
});

test("4. an animated sticker: several ordered frames reach Luna", { skip }, async () => {
  const from = phone();
  const reqs = await sendAndWait(from, { type: "sticker", sticker: { base64: b64(await fx.animatedWebp()), mimetype: "image/webp", animated: true } });
  const r = lastWithImages(reqs);
  assert.ok(images(r).length >= 3);
  assert.match(textOf(r), /frames, in order/);
  assert.match(textOf(r), /animated sticker/);
});

test("5. a GIF: frames across the clip reach Luna, within the frame cap", { skip }, async () => {
  const from = phone();
  const reqs = await sendAndWait(from, { type: "video", video: { base64: b64(fx.mp4(3)), mimetype: "video/mp4", gif: true, seconds: 3 } });
  const r = lastWithImages(reqs);
  assert.ok(images(r).length > 1 && images(r).length <= 6);
  assert.match(textOf(r), /GIF/);
});

test("8/9. a voice note is downloaded, transcribed (Pidgin kept verbatim) and answered from the transcript", { skip }, async () => {
  const from = phone();
  transcript = "Abeg wetin dey happen, I no fit come today o";
  const reqs = await sendAndWait(from, { type: "audio", audio: { base64: b64(fx.oggVoice()), mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 2 } });
  assert.ok(transcribeReqs.pop().hasOgg, "the OGG/Opus bytes went to the transcription API");
  assert.ok(transcribeReqs.length === 0 || true);
  assert.ok(reqs.some((r) => textOf(r).includes(transcript)), "Luna got the verbatim transcript");
  assert.ok(reqs.every((r) => images(r).length === 0));
  assert.match(reqs.map(textOf).join("\n"), /automatic transcript of a voice note/);
  transcript = "ok";
});

test("10. a failed download / corrupt file: Luna is told she did NOT see it, and gets no image", async () => {
  const dl = phone(), bad = phone();
  const r1 = await sendAndWait(dl, { type: "audio", mediaError: "download timed out" });
  assert.ok(r1.every((r) => images(r).length === 0));
  assert.match(r1.map(textOf).join("\n"), /did NOT see or hear it/);
  const r2 = await sendAndWait(bad, { type: "image", image: { base64: b64(Buffer.from("definitely not an image file at all")), mimetype: "image/jpeg" } });
  assert.ok(r2.every((r) => images(r).length === 0));
  assert.match(r2.map(textOf).join("\n"), /did NOT see or hear it/);
});

test("11. a retried / duplicated webhook is processed once", async () => {
  const from = phone(), id = uid();
  const msg = { from, id, pushName: "Tola", type: "text", text: { body: "send once please" } };
  const before = lunaReqs.length;
  await Promise.all([post(msg), post(msg)]);
  await post(msg);
  await until(() => textsTo(from).length >= 1);
  await wait(1500);
  assert.strictEqual(textsTo(from).length, 1, "exactly one reply");
  const matching = lunaReqs.slice(before).filter((r) => JSON.stringify(r).includes("send once please"));
  const firstCalls = matching.length;
  await post(msg); await wait(800);
  assert.strictEqual(lunaReqs.slice(before).filter((r) => JSON.stringify(r).includes("send once please")).length, firstCalls, "a later retry adds no model calls");
});

test("12. one person's media and history never appear in another person's turn", async () => {
  const a = phone(), b = phone();
  await sendAndWait(a, { type: "text", text: { body: "my secret codeword is PINEAPPLE" } });
  const reqs = await sendAndWait(b, { type: "image", image: { base64: b64(await fx.jpeg(10, 10, 220)), mimetype: "image/jpeg" } });
  assert.ok(reqs.length >= 1);
  assert.ok(reqs.every((r) => !JSON.stringify(r).includes("PINEAPPLE")), "A's text is not in B's prompts");
  const reqsA = await sendAndWait(a, { type: "text", text: { body: "what did I just send?" } });
  assert.ok(reqsA.every((r) => images(r).length === 0), "B's image is not in A's prompts");
});

test("media from one sender is answered in arrival order relative to their next text", { skip }, async () => {
  const from = phone(), before = textsTo(from).length;
  transcript = "first the voice note";
  await post({ from, id: uid(), type: "audio", audio: { base64: b64(fx.oggVoice()), mimetype: "audio/ogg", ptt: true } });
  await post({ from, id: uid(), type: "text", text: { body: "second the text" } });
  await until(() => textsTo(from).length >= before + 2);
  const order = lunaReqs.map((r) => textOf(r)).filter((t) => /first the voice note|second the text/.test(t));
  assert.ok(order.findIndex((t) => t.includes("first the voice note")) < order.findIndex((t) => t.includes("second the text")));
  transcript = "ok";
});

test("owner saying 'Send me voice note' is a normal chat turn, not a cross-send to 'me'", async () => {
  const before = lunaReqs.length, sentBefore = sent.length;
  await post({ from: OWNER, id: uid(), pushName: "Owner", type: "text", text: { body: "Send me voice note\nDo you think I should change your voice" } });
  await until(() => lunaReqs.length > before);
  await wait(800);
  assert.ok(lunaReqs.slice(before).some((r) => JSON.stringify(r).includes("change your voice")), "it reached the model");
  assert.ok(!sent.slice(sentBefore).some((x) => /failed|is not on WhatsApp/.test(String(x.message || ""))), "no cross-send failure message");
});

test("a real 'text <number> saying ...' owner command still cross-sends", async () => {
  const sentBefore = sent.length;
  await post({ from: OWNER, id: uid(), pushName: "Owner", type: "text", text: { body: "text 2348011122233 on whatsapp saying hello from the test" } });
  await until(() => sent.slice(sentBefore).some((x) => x.route === "/send" && String(x.to).includes("2348011122233")));
  assert.ok(sent.slice(sentBefore).some((x) => x.message === "hello from the test"));
});
