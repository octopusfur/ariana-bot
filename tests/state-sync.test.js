"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

// A tiny fake of Supabase's REST API (the `sessions` table)
const rows = new Map();
const server = http.createServer((req, res) => {
  let d = ""; req.on("data", (c) => (d += c));
  req.on("end", () => {
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify([...rows.values()].map((r) => ({ key: r.key, data: r.data }))));
    }
    const r = JSON.parse(d); rows.set(r.key, r); res.writeHead(201); res.end();
  });
});

let sync, root;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
  fs.mkdirSync(path.join(root, "brain"));
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_KEY = "k";
  process.env.STATE_SYNC_ROOT = root;
  sync = require("../state_sync");
});
test.after(() => server.close());

test("a file the engines change is saved, an unchanged one is not", async () => {
  fs.writeFileSync(path.join(root, "universal_memory.json"), JSON.stringify({ facts: ["default"] }));
  sync.snapshotBaseline();
  assert.strictEqual(await sync.pushChanged(), 0, "nothing changed yet");
  fs.writeFileSync(path.join(root, "universal_memory.json"), JSON.stringify({ facts: ["Ayodele is my owner"] }));
  assert.strictEqual(await sync.pushChanged(), 1);
  assert.ok(rows.has("universal_memory.json"));
  assert.strictEqual(await sync.pushChanged(), 0, "already saved");
});

test("after a 'redeploy' (files wiped) restore brings the memory back", async () => {
  fs.rmSync(path.join(root, "universal_memory.json"));
  assert.strictEqual(await sync.restore(), 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, "universal_memory.json"), "utf8")), { facts: ["Ayodele is my owner"] });
});

test("a half-written (corrupt) file is never uploaded or restored", async () => {
  fs.writeFileSync(path.join(root, "human_state.json"), "{ not json");
  assert.strictEqual(await sync.pushChanged(), 0);
  rows.set("wants.json", { key: "wants.json", data: { content: "{ broken" } });
  rows.set("../evil.json", { key: "../evil.json", data: { content: "{}" } });
  await sync.restore();
  assert.ok(!fs.existsSync(path.join(root, "wants.json")));
  assert.ok(!fs.existsSync(path.join(root, "..", "evil.json")));
});
