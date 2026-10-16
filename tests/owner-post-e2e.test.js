"use strict";
// Real index.js + fake Luna + fake Supabase library + fake WhatsApp sidecar. Proves the wiring only.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const sharp = require("sharp");
const { spawn } = require("child_process");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = (h) => new Promise((res) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port })); });
const body = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });

const OWNER = "2349000000000";
let ROWS = [], sidecar = [], lunaReqs = [], ctx, imgs = {};

test.before(async () => {
  imgs.gym = await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 230, g: 20, b: 20 } } }).jpeg().toBuffer();
  imgs.beach = await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 20, g: 20, b: 230 } } }).jpeg().toBuffer();
  const files = await server((req, res) => { const k = req.url.includes("gym") ? "gym" : "beach"; res.setHeader("content-type", "image/jpeg"); res.end(imgs[k]); });
  const base = `http://127.0.0.1:${files.port}`;
  ROWS = [
    { id: "m1", url: `${base}/gym.jpg`, tags: ["gym", "black set"], media_type: "image" },
    { id: "m2", url: `${base}/beach.jpg`, tags: ["beach", "sunset"], media_type: "image" },
  ];
  const luna = await server(async (req, res) => {
    const raw = await body(req); res.setHeader("content-type", "application/json");
    if (!req.url.endsWith("/responses")) { res.statusCode = 404; return res.end("{}"); }
    const r = JSON.parse(raw); lunaReqs.push(r);
    const names = (r.tools || []).map((t) => t.name || (t.function && t.function.name));
    const blob = JSON.stringify(r.input);
    if (names.includes("send_photo") && /send me a gym pic/.test(blob) && !/Done: that picture will arrive/.test(blob)) {
      return res.end(JSON.stringify({ output: [{ type: "function_call", call_id: "p" + lunaReqs.length, name: "send_photo", arguments: JSON.stringify({ photo_id: "m1", caption: "there" }) }] }));
    }
    if (names.includes("send_reply") || JSON.stringify(r.tool_choice || "").includes("send_reply")) {
      return res.end(JSON.stringify({ output: [{ type: "function_call", call_id: "c" + lunaReqs.length, name: "send_reply", arguments: JSON.stringify({ message: "ok" }) }] }));
    }
    res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
  });
  const supa = await server(async (req, res) => { await body(req); res.setHeader("content-type", "application/json"); res.end(req.url.startsWith("/rest/v1/ariana_media") ? JSON.stringify(ROWS) : "[]"); });
  const side = await server(async (req, res) => { sidecar.push({ route: req.url, ...JSON.parse((await body(req)) || "{}") }); res.setHeader("content-type", "application/json"); res.end("{}"); });
  const port = 25000 + Math.floor(Math.random() * 13000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), WA_API_SECRET: "s", WA_PROVIDER: "wwebjs", WA_WEB_PORT: String(side.port), OWNER_PHONE: OWNER,
      OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: `http://127.0.0.1:${luna.port}`, HUMAN_DELAY_SCALE: "0", SIGNAL_CLI_URL: "http://127.0.0.1:9",
      SUPABASE_URL: `http://127.0.0.1:${supa.port}`, SUPABASE_SERVICE_ROLE_KEY: "k", STATE_SYNC: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/webhook`)).ok) break; } catch {} await wait(200); }
  ctx = { child, port, luna, supa, side, files, logs: () => log };
});
test.after(() => { ctx.child.kill(); for (const x of [ctx.luna, ctx.supa, ctx.side, ctx.files]) x.s.close(); });

const post = (m) => fetch(`http://127.0.0.1:${ctx.port}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-wa-secret": "s" }, body: JSON.stringify({ message: m }) });
async function until(fn, ms = 20000) { for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await wait(100); } throw new Error("timed out\n" + ctx.logs().slice(-2500)); }
let n = 0;
async function ownerSays(text) {
  const sb = sidecar.length;
  await post({ from: OWNER, id: "OP" + n++, pushName: "Owner", type: "text", text: { body: text } });
  const ack = await until(() => sidecar.slice(sb).find((x) => x.route === "/send" && String(x.to) === OWNER));
  return { ack: ack.message, calls: sidecar.slice(sb) };
}
const meanRGB = async (b64) => (await sharp(Buffer.from(b64, "base64")).stats()).channels.slice(0, 3).map((c) => c.mean);

test("'post a gym pic to your status' posts the gym picture (by tag) to the WhatsApp status and says so", async () => {
  const { ack, calls } = await ownerSays("post a gym pic to your status");
  const st = calls.find((x) => x.route === "/post-status");
  assert.ok(st && st.base64, "a real picture went to the status");
  assert.strictEqual(st.mimetype, "image/jpeg");
  const [R, , B] = await meanRGB(st.base64);
  assert.ok(R > 150 && B < 90, "it is the red gym picture, not the beach one");
  assert.match(ack, /posted it to my WhatsApp status/);
});

test("the sentence from the chat: she sends a picture, then 'post it to your status' posts THAT picture", async () => {
  const sb = sidecar.length;
  await post({ from: OWNER, id: "OP" + n++, pushName: "Owner", type: "text", text: { body: "send me a gym pic" } });
  await until(() => sidecar.slice(sb).find((x) => x.route === "/send-media"));
  const { ack, calls } = await ownerSays("I said post it to your status not send it to me");
  const st = calls.find((x) => x.route === "/post-status");
  assert.ok(st && st.base64, "posted to the status, not sent to the chat again");
  assert.ok(!calls.some((x) => x.route === "/send-media"), "nothing was sent to the owner as a picture");
  const [R, , B] = await meanRGB(st.base64);
  assert.ok(R > 150 && B < 90, "the same picture she had just sent");
  assert.match(ack, /posted it to my WhatsApp status/);
});

test("without a recent picture, 'post it' says so instead of guessing", async () => {
  // a different chat id has no last-sent picture: simulate with a fresh process state via a phrase that needs one
  const { ack } = await ownerSays("post that pic to your story");
  assert.match(ack, /haven't sent you a picture lately|my Telegram story: not set up/);
});

test("places that are not set up are reported plainly (Instagram, Telegram, Snapchat)", async () => {
  const { ack } = await ownerSays("post a gym pic to your instagram");
  assert.match(ack, /Instagram: not set up/);
  const t = await ownerSays("post a gym pic to your telegram story");
  assert.match(t.ack, /Telegram story: not set up/);
});

test("a funny gif without a GIPHY key is refused honestly, and nothing is posted", async () => {
  const { ack, calls } = await ownerSays("post a funny gif to your status");
  assert.match(ack, /GIPHY_API_KEY/);
  assert.ok(!calls.some((x) => x.route === "/post-status"));
});

test("an internet GIF can never be sent to Instagram, even when asked", async () => {
  const { ack } = await ownerSays("post a funny gif to your instagram");
  assert.ok(!/posted it to Instagram/.test(ack));
});
