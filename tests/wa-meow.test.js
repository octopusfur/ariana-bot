"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { pathToFileURL } = require("url");

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
    const r = await call(port, "POST", "/send-media", { to: "2348012345678", base64: Buffer.from("RIFFxxxx").toString("base64"), sticker: true, animated: false });
    assert.strictEqual(r.status, 200);
    const line = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
    assert.strictEqual(line.op, "sendRawMessage");
    assert.ok(line.msg.stickerMessage, "should be a stickerMessage");
    assert.strictEqual(line.msg.stickerMessage.mimetype, "image/webp");
  } finally { child.kill(); }
});
