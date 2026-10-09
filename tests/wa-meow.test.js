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
