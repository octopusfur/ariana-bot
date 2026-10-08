"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const express = require("express");

process.env.FB_PAGE_TOKEN = "tok";
process.env.FB_APP_SECRET = "shh";
process.env.FB_VERIFY_TOKEN = "verify123";
const messenger = require("../messenger");

const sign = (body, secret = "shh") => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

test("verifySignature accepts a valid HMAC and fails closed otherwise", () => {
  const raw = Buffer.from('{"a":1}');
  assert.ok(messenger.verifySignature(raw, sign(raw), "shh"));
  assert.ok(!messenger.verifySignature(raw, sign(raw, "other"), "shh"));
  assert.ok(!messenger.verifySignature(raw, "", "shh"));
  assert.ok(!messenger.verifySignature(raw, sign(raw), ""));
});

test("extractEvents keeps user text/postbacks and drops echoes", () => {
  const ev = messenger.extractEvents({ object: "page", entry: [{ messaging: [
    { sender: { id: "1" }, message: { mid: "m1", text: "hi" } },
    { sender: { id: "2" }, message: { mid: "m2", text: "echo", is_echo: true } },
    { sender: { id: "3" }, message: { mid: "m3", attachments: [{ type: "image" }] } },
    { sender: { id: "4" }, postback: { title: "Get started", payload: "X" }, timestamp: 5 },
  ] }] });
  assert.deepStrictEqual(ev.map((e) => [e.psid, e.text]), [["1", "hi"], ["3", "[image]"], ["4", "Get started"]]);
});

test("webhook: verify handshake, rejects bad signature, delivers a signed message", async () => {
  const app = express();
  app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
  const got = [];
  messenger.init({ app, requireAuth: (_q, _s, n) => n(), getSupabase: () => null, onMessage: async (m) => { got.push(m); } });
  const server = app.listen(0);
  const port = server.address().port;
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
  try {
    assert.strictEqual((await call("GET", "/messenger?hub.mode=subscribe&hub.verify_token=verify123&hub.challenge=42")).body, "42");
    assert.strictEqual((await call("GET", "/messenger?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42")).status, 403);
    const body = JSON.stringify({ object: "page", entry: [{ messaging: [{ sender: { id: "77" }, message: { mid: "mm1", text: "hello ariana" } }] }] });
    assert.strictEqual((await call("POST", "/messenger", body, { "x-hub-signature-256": "sha256=bad" })).status, 401);
    assert.strictEqual((await call("POST", "/messenger", body, { "x-hub-signature-256": sign(body) })).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].id, "fb_77");
    assert.strictEqual(got[0].platform, "messenger");
    assert.strictEqual(got[0].text, "hello ariana");
    // duplicate delivery (Meta retry) is ignored
    await call("POST", "/messenger", body, { "x-hub-signature-256": sign(body) });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(got.length, 1);
  } finally { server.close(); }
});
