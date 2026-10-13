"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { pathToFileURL } = require("url");

const fx = require("./helpers-media");
const STUB = pathToFileURL(path.join(__dirname, "fixtures", "fake-whatsmeow.mjs")).href;

function launch(extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "wa-meow.js")], {
    env: { PATH: process.env.PATH, WA_MEOW_MODULE: STUB, WA_WEB_PORT: String(port), WA_DATA_DIR: dir, WA_BACKUP: "off", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("sidecar on")) resolve({ child, port }); });
    child.on("error", reject);
    setTimeout(() => reject(new Error("sidecar did not start")), 8000);
  });
}
const call = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ port, host: "127.0.0.1", method, path: p, headers: { "content-type": "application/json", ...headers } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("admin key set, no API secret: dashboard calls (no key) still work, public pages stay locked", async () => {
  const { child, port } = await launch({ WA_ADMIN_KEY: "k3y" });
  try {
    await wait(300);
    const st = await call(port, "GET", "/status");
    assert.strictEqual(st.status, 200);
    assert.strictEqual(JSON.parse(st.body).connected, false);
    const bad = await call(port, "POST", "/pair", { phone: "" });
    assert.strictEqual(bad.status, 400);                       // auth passed, number rejected
    const ok = await call(port, "POST", "/pair", { phone: "+1 (530) 400-3829" });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).code, "ABCD-EFGH"); // reconnects first, then issues the code
    assert.strictEqual((await call(port, "GET", "/")).status, 401);
    assert.strictEqual((await call(port, "GET", "/?key=k3y")).status, 200);
  } finally { child.kill(); }
});

test("API secret set: POST /pair needs the bearer, with it the code comes back", async () => {
  const { child, port } = await launch({ WA_API_SECRET: "s3cret", WA_ADMIN_KEY: "k3y" });
  try {
    await wait(300);
    assert.strictEqual((await call(port, "POST", "/pair", { phone: "15304003829" })).status, 401);
    const ok = await call(port, "POST", "/pair", { phone: "15304003829" }, { authorization: "Bearer s3cret" });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).code, "ABCD-EFGH");
    assert.strictEqual((await call(port, "GET", "/status", null, { authorization: "Bearer s3cret" })).status, 200);
  } finally { child.kill(); }
});

// ── Identity (@lid → phone), stickers ─────────────────────────
const { DatabaseSync } = require("node:sqlite");

function webhookSink() {
  const got = [];
  const server = http.createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => { try { got.push(JSON.parse(d)); } catch {} res.end("{}"); });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ got, server, port: server.address().port })));
}
const msgEvent = (sender, extra = {}) => JSON.stringify({ info: { id: "M1", chat: sender, sender, isFromMe: false, isGroup: false, timestamp: 1, pushName: "Owner" }, message: { conversation: "hi", ...extra } });

async function runInbound({ lidRow, aliases, message }) {
  const sink = await webhookSink();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-"));
  if (lidRow) { // what whatsmeow keeps in its session database
    const db = new DatabaseSync(path.join(dir, "session.db"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE whatsmeow_lid_map(lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL);");
    db.prepare("INSERT INTO whatsmeow_lid_map VALUES(?,?)").run(lidRow[0], lidRow[1]);
    db.close();
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "wa-meow.js")], {
    env: { PATH: process.env.PATH, WA_MEOW_MODULE: STUB, WA_WEB_PORT: String(port), WA_DATA_DIR: dir, WA_BACKUP: "off", MAIN_APP_URL: `http://127.0.0.1:${sink.port}`,
      FAKE_EMIT: "1", FAKE_MESSAGE: message, ...(aliases ? { WA_LID_ALIASES: aliases } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    for (let i = 0; i < 60 && !sink.got.length; i++) await wait(100);
    return sink.got[0];
  } finally { child.kill(); sink.server.close(); }
}

test("a message from an @lid contact arrives under their real phone number (so memory and owner checks work)", async () => {
  const hit = await runInbound({ lidRow: ["123456789012345", "2348012345678"], message: msgEvent("123456789012345@lid") });
  assert.strictEqual(hit.message.from, "2348012345678");
});

test("an unmapped @lid keeps the lid, and WA_LID_ALIASES can map it by hand", async () => {
  const none = await runInbound({ message: msgEvent("555555555555555@lid") });
  assert.strictEqual(none.message.from, "555555555555555");
  const aliased = await runInbound({ aliases: "555555555555555=2349099988877", message: msgEvent("555555555555555@lid") });
  assert.strictEqual(aliased.message.from, "2349099988877");
});

test("normal phone-addressed contacts are untouched", async () => {
  const hit = await runInbound({ message: msgEvent("2348055500011@s.whatsapp.net") });
  assert.strictEqual(hit.message.from, "2348055500011");
});

test("an inbound sticker is forwarded with its bytes so Ariana can learn it", async () => {
  const hit = await runInbound({ lidRow: ["123456789012345", "2348012345678"], message: JSON.stringify({ info: { id: "S1", chat: "123456789012345@lid", sender: "123456789012345@lid", isFromMe: false, isGroup: false, timestamp: 1, pushName: "Owner" }, message: { stickerMessage: { mimetype: "image/webp", isAnimated: false } } }) });
  assert.strictEqual(hit.message.type, "sticker");
  assert.strictEqual(Buffer.from(hit.message.sticker.base64, "base64").toString().startsWith("RIFF"), true);
});

test("/send-media with sticker:true sends a stickerMessage", async () => {
  const log = path.join(os.tmpdir(), "fake-" + Date.now() + ".log");
  const { child, port } = await launch({ FAKE_EMIT: "1", FAKE_LOG: log });
  try {
    await wait(400);
    const r = await call(port, "POST", "/send-media", { to: "2348012345678", base64: (await fx.staticWebp()).toString("base64"), sticker: true, animated: false });
    assert.strictEqual(r.status, 200);
    const line = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
    assert.strictEqual(line.op, "sendRawMessage");
    assert.ok(line.msg.stickerMessage, "should be a stickerMessage");
    assert.strictEqual(line.msg.stickerMessage.mimetype, "image/webp");
  } finally { child.kill(); }
});

test("an inbound photo is forwarded with its bytes so Ariana can look at it", async () => {
  const hit = await runInbound({ lidRow: ["123456789012345", "2348012345678"], message: JSON.stringify({ info: { id: "I1", chat: "123456789012345@lid", sender: "123456789012345@lid", isFromMe: false, isGroup: false, timestamp: 1, pushName: "Owner" }, message: { imageMessage: { caption: "look", mimetype: "image/jpeg" } } }) });
  assert.strictEqual(hit.message.type, "image");
  assert.strictEqual(hit.message.image.caption, "look");
  assert.strictEqual(hit.message.image.mimetype, "image/jpeg");
  assert.ok(Buffer.from(hit.message.image.base64, "base64").length > 0);
});

test("/post-status posts a text Status to status@broadcast", async () => {
  const log = path.join(os.tmpdir(), "fake-st-" + Date.now() + ".log");
  const { child, port } = await launch({ FAKE_EMIT: "1", FAKE_LOG: log });
  try {
    await wait(400);
    const r = await call(port, "POST", "/post-status", { text: "coffee first, opinions later" });
    assert.strictEqual(r.status, 200);
    const line = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
    assert.strictEqual(line.jid, "status@broadcast");
    assert.strictEqual(line.msg.extendedTextMessage.text, "coffee first, opinions later");
    assert.ok(line.msg.extendedTextMessage.backgroundArgb > 0xFF000000, "has a background colour");
    assert.strictEqual((await call(port, "POST", "/post-status", { text: "  " })).status, 500, "empty text is refused");
  } finally { child.kill(); }
});

// ── Media in / out (real fixtures, fake WhatsApp library) ─────
const lastLog = (log) => JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
const tmpFile = (buf, ext) => { const f = path.join(os.tmpdir(), `wm_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`); fs.writeFileSync(f, buf); return f; };
const inboundMsg = (id, message) => JSON.stringify({ info: { id, chat: "2348055500011@s.whatsapp.net", sender: "2348055500011@s.whatsapp.net", isFromMe: false, isGroup: false, timestamp: 1, pushName: "Tola" }, message });
async function inboundWith(message, extraEnv = {}) {
  const sink = await webhookSink();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "wa-meow.js")], {
    env: { PATH: process.env.PATH, WA_MEOW_MODULE: STUB, WA_WEB_PORT: String(port), WA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wam-")), WA_BACKUP: "off", MAIN_APP_URL: `http://127.0.0.1:${sink.port}`, FAKE_EMIT: "1", FAKE_MESSAGE: message, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"] });
  try { for (let i = 0; i < 80 && !sink.got.length; i++) await wait(100); return sink.got[0]; }
  finally { child.kill(); sink.server.close(); }
}
const skipFx = fx.hasFfmpeg ? false : "ffmpeg not installed";

test("6. an outgoing sticker is uploaded and delivered as a real stickerMessage (animated flag kept)", async () => {
  const log = path.join(os.tmpdir(), "fake-stk-" + Date.now() + ".log");
  const { child, port } = await launch({ FAKE_EMIT: "1", FAKE_LOG: log });
  try {
    await wait(400);
    const webp = await fx.staticWebp();
    assert.strictEqual((await call(port, "POST", "/send-media", { to: "2348012345678", base64: webp.toString("base64"), sticker: true, animated: true })).status, 200);
    let line = lastLog(log);
    assert.ok(line.msg.stickerMessage && !line.msg.imageMessage);
    assert.strictEqual(line.msg.stickerMessage.isAnimated, true);
    assert.strictEqual(line.msg.stickerMessage.mimetype, "image/webp");
    assert.ok(line.msg.stickerMessage.directPath, "media was uploaded, not just referenced by URL");
    // a PNG is converted to a WhatsApp-legal WebP rather than sent as-is
    assert.strictEqual((await call(port, "POST", "/send-media", { to: "2348012345678", base64: (await fx.png()).toString("base64"), sticker: true })).status, 200);
    assert.strictEqual(lastLog(log).msg.stickerMessage.mimetype, "image/webp");
    // oversized stickers are refused instead of being rejected later by WhatsApp
    const big = await require("sharp")({ create: { width: 512, height: 512, channels: 3, background: "#000" } }).webp({ lossless: true }).toBuffer();
    const noisy = Buffer.alloc(600000); require("crypto").randomFillSync(noisy);
    const tooBig = await call(port, "POST", "/send-media", { to: "2348012345678", base64: Buffer.concat([big.subarray(0, 12), noisy]).toString("base64"), sticker: true });
    assert.notStrictEqual(tooBig.status, 200);
  } finally { child.kill(); }
});

test("7. an outgoing GIF goes out as an MP4 videoMessage with gifPlayback (WhatsApp has no native GIF type)", { skip: skipFx }, async () => {
  const log = path.join(os.tmpdir(), "fake-gif-" + Date.now() + ".log");
  const { child, port } = await launch({ FAKE_EMIT: "1", FAKE_LOG: log });
  try {
    await wait(400);
    const fromGif = await call(port, "POST", "/send-media", { to: "2348012345678", base64: fx.colourGif().toString("base64"), gif: true });
    assert.strictEqual(fromGif.status, 200, fromGif.body);
    let m = lastLog(log).msg.videoMessage;
    assert.ok(m && m.gifPlayback === true);
    assert.strictEqual(m.mimetype, "video/mp4");
    const fromMp4 = await call(port, "POST", "/send-media", { to: "2348012345678", base64: fx.mp4(2).toString("base64"), mimetype: "video/mp4", gif: true });
    assert.strictEqual(fromMp4.status, 200);
    assert.strictEqual(lastLog(log).msg.videoMessage.gifPlayback, true);
    const bad = await call(port, "POST", "/send-media", { to: "2348012345678", base64: Buffer.from("not media at all, sorry").toString("base64"), gif: true });
    assert.notStrictEqual(bad.status, 200, "garbage is not sent as a GIF");
  } finally { child.kill(); }
});

test("inbound voice note is forwarded with its OGG bytes and the push-to-talk flag", { skip: skipFx }, async () => {
  const ogg = tmpFile(fx.oggVoice(), "ogg");
  const hit = await inboundWith(inboundMsg("A1", { audioMessage: { PTT: true, seconds: 2, mimetype: "audio/ogg; codecs=opus" } }), { FAKE_DOWNLOAD_FILE: ogg });
  assert.strictEqual(hit.message.type, "audio");
  assert.strictEqual(hit.message.audio.ptt, true);
  assert.strictEqual(Buffer.from(hit.message.audio.base64, "base64").toString("latin1", 0, 4), "OggS");
  assert.strictEqual(hit.message.mediaError, undefined);
});

test("inbound GIF (gifPlayback video) is flagged and forwarded; animated sticker keeps its flag", { skip: skipFx }, async () => {
  const mp4f = tmpFile(fx.mp4(2), "mp4");
  const gif = await inboundWith(inboundMsg("V1", { videoMessage: { gifPlayback: true, seconds: 2, mimetype: "video/mp4" } }), { FAKE_DOWNLOAD_FILE: mp4f });
  assert.strictEqual(gif.message.video.gif, true);
  assert.strictEqual(Buffer.from(gif.message.video.base64, "base64").toString("latin1", 4, 8), "ftyp");
  const aw = tmpFile(await fx.animatedWebp(), "webp");
  const stk = await inboundWith(inboundMsg("S9", { stickerMessage: { isAnimated: true, mimetype: "image/webp" } }), { FAKE_DOWNLOAD_FILE: aw });
  assert.strictEqual(stk.message.sticker.animated, true);
});

test("10. a failed download, an over-long clip or an oversized file is reported as such, never as media", async () => {
  const failed = await inboundWith(inboundMsg("F1", { audioMessage: { PTT: true, seconds: 3 } }), { FAKE_DOWNLOAD_FAIL: "1" });
  assert.strictEqual(failed.message.type, "audio");
  assert.ok(failed.message.mediaError, "the main app is told the download failed");
  assert.strictEqual(failed.message.audio, undefined, "no bytes are invented");
  const tooLong = await inboundWith(inboundMsg("F2", { videoMessage: { gifPlayback: false, seconds: 400 } }));
  assert.strictEqual(tooLong.message.mediaError, "too long");
  const huge = tmpFile(Buffer.alloc(4100000, 1), "webp");
  const tooBig = await inboundWith(inboundMsg("F3", { imageMessage: { mimetype: "image/jpeg" } }), { FAKE_DOWNLOAD_FILE: huge });
  assert.strictEqual(tooBig.message.mediaError, "too large");
});
