"use strict";
// Real index.js + fake Luna + fake Supabase (PostgREST) + fake sidecar. Proves the wiring only.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = (h) => new Promise((res) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port })); });
const body = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });

const ROWS = [
  { id: "m1", url: "https://cdn.example.com/gym.jpg", tags: ["gym", "black set", "mirror selfie"], media_type: "image" },
  { id: "m2", url: "https://cdn.example.com/beach.jpg", tags: ["beach", "sunset"], media_type: "image" },
  { id: "m3", url: "https://cdn.example.com/untagged.jpg", tags: [], media_type: "image" },
];
const lunaReqs = [], sidecar = [];
let ctx;
test.before(async () => {
  const luna = await server(async (req, res) => {
    const raw = await body(req); res.setHeader("content-type", "application/json");
    if (!req.url.endsWith("/responses")) { res.statusCode = 404; return res.end("{}"); }
    const r = JSON.parse(raw); lunaReqs.push(r);
    const names = (r.tools || []).map((t) => t.name || (t.function && t.function.name));
    if (names.includes("send_reply") || JSON.stringify(r.tool_choice || "").includes("send_reply")) {
      return res.end(JSON.stringify({ output: [{ type: "function_call", call_id: "c" + lunaReqs.length, name: "send_reply", arguments: JSON.stringify({ message: "here you go" }) }] }));
    }
    res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
  });
  const supa = await server(async (req, res) => {
    await body(req); res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/rest/v1/ariana_media")) return res.end(JSON.stringify(ROWS));
    res.end("[]");
  });
  const side = await server(async (req, res) => { sidecar.push({ route: req.url, ...JSON.parse((await body(req)) || "{}") }); res.setHeader("content-type", "application/json"); res.end("{}"); });
  const port = 23000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), WA_API_SECRET: "s", WA_PROVIDER: "wwebjs", WA_WEB_PORT: String(side.port),
      OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: `http://127.0.0.1:${luna.port}`, HUMAN_DELAY_SCALE: "0", SIGNAL_CLI_URL: "http://127.0.0.1:9",
      SUPABASE_URL: `http://127.0.0.1:${supa.port}`, SUPABASE_SERVICE_ROLE_KEY: "test-key" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/webhook`)).ok) break; } catch {} await wait(200); }
  ctx = { child, port, luna, supa, side, logs: () => log };
});
test.after(() => { ctx.child.kill(); ctx.luna.s.close(); ctx.supa.s.close(); ctx.side.s.close(); });

const post = (m) => fetch(`http://127.0.0.1:${ctx.port}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-wa-secret": "s" }, body: JSON.stringify({ message: m }) });
async function until(fn, ms = 20000) { for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await wait(100); } throw new Error("timed out\n" + ctx.logs().slice(-1800)); }
const phone = () => "23480" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
let n = 0;
const instructionsOf = (r) => JSON.stringify(r.instructions || "") + JSON.stringify((r.input || []).filter((m) => m.role === "system" || m.role === "developer"));

test("asking for a gym pic sends the gym photo and tells her exactly what it shows", async () => {
  const from = phone(), before = lunaReqs.length, sb = sidecar.length;
  await post({ from, id: "TG" + n++, type: "text", text: { body: "send me a gym pic" } });
  const sent = await until(() => sidecar.slice(sb).find((x) => x.route === "/send-media" && String(x.to) === from));
  assert.strictEqual(sent.url, "https://cdn.example.com/gym.jpg", "the tag-matching picture was sent");
  const told = lunaReqs.slice(before).some((r) => /PICTURE YOU ARE SENDING/.test(instructionsOf(r)) && /tagged: gym, black set, mirror selfie/.test(instructionsOf(r)));
  assert.ok(told, "Luna was told what the picture shows before writing her reply");
});

test("an untagged picture: she is told she does not know what it shows", async () => {
  const from = phone(), before = lunaReqs.length, sb = sidecar.length;
  await post({ from, id: "TG" + n++, type: "text", text: { body: "send me a selfie of you in a spacesuit" } });
  await until(() => sidecar.slice(sb).find((x) => x.route === "/send-media" && String(x.to) === from));
  const reqs = lunaReqs.slice(before).map(instructionsOf).join("\n");
  assert.match(reqs, /PICTURE YOU ARE SENDING/);
});
