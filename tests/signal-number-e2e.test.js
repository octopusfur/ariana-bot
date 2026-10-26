"use strict";
// Real index.js + a fake signal-cli REST service: the dashboard endpoint turns a private Signal ID into a phone number.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = (h) => new Promise((res) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port })); });

const KNOWN = "1f3b9a40-5c2e-4d7a-9a11-77aa22bb33cc", UNKNOWN = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
let ctx;
test.before(async () => {
  const sig = await server((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/identities/")) return res.end(JSON.stringify([{ number: "+2349015007290", uuid: KNOWN }]));
    res.statusCode = 404; res.end("{}");
  });
  const port = 26000 + Math.floor(Math.random() * 12000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), WA_API_SECRET: "s", WA_PROVIDER: "wwebjs", WA_WEB_PORT: "1", SIGNAL_NUMBER: "+14303629477", SIGNAL_CLI_URL: `http://127.0.0.1:${sig.port}`, STATE_SYNC: "off" },
    stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/webhook`)).ok) break; } catch {} await wait(200); }
  ctx = { child, port, sig, logs: () => log };
});
test.after(() => { ctx.child.kill(); ctx.sig.s.close(); });
const get = async (id) => (await fetch(`http://127.0.0.1:${ctx.port}/api/signal/number?id=${encodeURIComponent(id)}`)).json();

test("a known private ID resolves to its phone number through the real endpoint", async () => {
  assert.deepStrictEqual(await get(`sg_${KNOWN}`), { ok: true, number: "+2349015007290" });
});
test("an ID Signal never shared the number for says so", async () => {
  const r = await get(`sg_${UNKNOWN}`);
  assert.strictEqual(r.number, null);
  assert.match(r.reason, /has not shared/);
});
test("a number passes straight through and junk is rejected", async () => {
  assert.strictEqual((await get("sg_2349015007290")).number, "+2349015007290");
  assert.strictEqual((await get("nonsense")).ok, false);
});
