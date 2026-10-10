"use strict";
/**
 * state_sync.js — keeps Ariana's runtime memory/state files alive across deploys.
 *
 * The engines (memory, emotional ledger, attraction, relationships, human state, wants, boundaries,
 * mood, memory registry, HARMES jobs) keep their state in JSON files on the server's disk. A
 * redeploy wipes that disk, which is why she "forgot" everything. This mirrors those files into
 * the Supabase `sessions` table (type = state_file) and restores them at boot, before the engines load.
 *
 *   node state_sync.js restore   (run synchronously from index.js before the engines are required)
 *   require('./state_sync').startMirror()  — upload changed files every 30 s; flush() on shutdown
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const ROOT = process.env.STATE_SYNC_ROOT || __dirname;
const FILES = [
  "universal_memory.json", "emotional_ledger.json", "attraction_matrix.json", "human_state.json",
  "wants.json", "boundaries.json", "mood_system.json",
  "brain/relationships.json", "brain/memory_registry.json", "brain/memory_registry.json.outbox.json", "brain/harmes_jobs.json",
];
const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || "";
const enabled = () => !!URL_BASE && !!KEY && process.env.STATE_SYNC !== "off";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const abs = (f) => path.join(ROOT, f);
const readLocal = (f) => { try { return fs.readFileSync(abs(f), "utf8"); } catch { return null; } };

function request(method, pathAndQuery, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(URL_BASE + pathAndQuery);
    const payload = body ? JSON.stringify(body) : null;
    const req = (u.protocol === "http:" ? http : https).request(u, {
      method, timeout: timeoutMs,
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(method === "POST" ? { Prefer: "resolution=merge-duplicates" } : {}), ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 120)}`))));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Pull saved files from Supabase and write them to disk. Returns how many were restored. */
async function restore() {
  if (!enabled()) return 0;
  const rows = JSON.parse(await request("GET", "/rest/v1/sessions?type=eq.state_file&select=key,data"));
  let n = 0;
  for (const r of rows) {
    if (!FILES.includes(r.key) || !r.data || typeof r.data.content !== "string") continue;
    try { JSON.parse(r.data.content); } catch { continue; } // never write a corrupt file
    fs.mkdirSync(path.dirname(abs(r.key)), { recursive: true });
    fs.writeFileSync(abs(r.key), r.data.content);
    n++;
  }
  return n;
}

const baseline = new Map(); // file -> hash we last saw / uploaded
let timer = null, inflight = Promise.resolve();

function snapshotBaseline() { for (const f of FILES) { const c = readLocal(f); baseline.set(f, c == null ? null : sha(c)); } }

async function pushChanged() {
  if (!enabled()) return 0;
  let n = 0;
  for (const f of FILES) {
    const c = readLocal(f);
    if (c == null) continue;
    const h = sha(c);
    if (baseline.get(f) === h) continue;
    try { JSON.parse(c); } catch { continue; } // wait for a complete write
    try {
      await request("POST", "/rest/v1/sessions?on_conflict=type,key", { type: "state_file", key: f, data: { content: c, savedAt: new Date().toISOString() }, updated_at: new Date().toISOString() });
      baseline.set(f, h); n++;
    } catch (e) { console.warn(`[state-sync] could not save ${f}: ${e.message}`); }
  }
  if (n) console.log(`[state-sync] saved ${n} file(s) to Supabase`);
  return n;
}

function startMirror(intervalMs = 30000) {
  if (!enabled() || timer) return;
  snapshotBaseline();
  timer = setInterval(() => { inflight = inflight.then(pushChanged).catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[state-sync] mirroring ${FILES.length} state files to Supabase`);
}
const flush = () => (enabled() ? (inflight = inflight.then(pushChanged).catch(() => {})) : Promise.resolve());

module.exports = { FILES, restore, startMirror, flush, pushChanged, snapshotBaseline, _baseline: baseline };

if (require.main === module && process.argv[2] === "restore") {
  restore().then((n) => { console.log(n ? `[state-sync] restored ${n} state file(s) from Supabase` : "[state-sync] nothing to restore"); process.exit(0); })
    .catch((e) => { console.warn("[state-sync] restore skipped:", e.message); process.exit(0); });
}
