"use strict";
/**
 * wa-meow.js — Ariana's WhatsApp text channel via whatsmeow (Go) through @whatsmeow-node/whatsmeow-node.
 * Drop-in for wa-web.js: SAME HTTP API (/send /typing /send-media /pair /reset /status /ping + admin UI),
 * SAME inbound webhook shape, so index.js is unchanged. No Chromium; one small Go binary (~20 MB RAM).
 *
 * Env:
 *   WA_STORE_URL   postgres://... (Supabase SESSION pooler, port 5432) -> session survives Render redeploys.
 *                  Unset = SQLite on local disk (lost on redeploy unless WA_DATA_DIR is a persistent disk).
 *   PHONE_NUMBER   auto pairing code instead of QR
 *   WA_API_SECRET, WA_ADMIN_KEY, WA_WEB_HOST, WA_WEB_PORT, MAIN_APP_URL, WA_UI_BASE  (same as wa-web.js)
 * NOTE: whatsmeow-node cannot use a proxy (SetProxy not exposed) — it connects directly from Render.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const axios = require("axios");
const qrcode = require("qrcode");

const PORT = Number(process.env.WA_WEB_PORT || 3001);
const MAIN_APP_URL = (process.env.MAIN_APP_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/\D/g, "");
const DATA_PATH = path.resolve(process.env.WA_DATA_DIR || "./.wa_meow");
const STORE = process.env.WA_STORE_URL || path.join(DATA_PATH, "session.db");
const HOST = process.env.WA_WEB_HOST || "127.0.0.1";
const EXPOSED = !["127.0.0.1", "localhost", "::1"].includes(HOST);
const API_SECRET = process.env.WA_API_SECRET || "";
const ADMIN_KEY = process.env.WA_ADMIN_KEY || "";
const UI_BASE = process.env.WA_UI_BASE !== undefined ? process.env.WA_UI_BASE : (EXPOSED ? "" : "/wa");
if (EXPOSED && (!API_SECRET || !ADMIN_KEY)) {
  console.error("❌ WA_API_SECRET and WA_ADMIN_KEY must both be set when WA_WEB_HOST is not localhost.");
  process.exit(1);
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { fs.mkdirSync(DATA_PATH, { recursive: true }); } catch {}

// ── SESSION BACKUP (Supabase `sessions` table) ────────────────
// Render's disk is wiped on every deploy. With a local SQLite store we copy the session
// (db + WAL) into Supabase after connecting and every few minutes, and restore it on boot,
// so a redeploy does not unlink WhatsApp. Skipped when WA_STORE_URL (Postgres) is used.
const DB_FILE = path.join(DATA_PATH, "session.db");
const SUPA_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || "";
const BACKUP_ON = STORE === DB_FILE && !!SUPA_URL && !!SUPA_KEY && process.env.WA_BACKUP !== "off";
const supaHeaders = () => ({ apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json" });
let lastBackupHash = "";

async function restoreBackup() {
  if (!BACKUP_ON || fs.existsSync(DB_FILE)) return;
  try {
    const r = await axios.get(`${SUPA_URL}/rest/v1/sessions?type=eq.wa_meow&key=eq.default&select=data`, { headers: supaHeaders(), timeout: 15000 });
    const d = r.data && r.data[0] && r.data[0].data;
    if (!d || !d.db) return console.log("ℹ️ No WhatsApp session backup yet — pair from the dashboard");
    fs.writeFileSync(DB_FILE, Buffer.from(d.db, "base64"));
    if (d.wal) fs.writeFileSync(DB_FILE + "-wal", Buffer.from(d.wal, "base64"));
    console.log(`♻️ Restored WhatsApp session from backup (${d.savedAt || "unknown time"})`);
  } catch (e) { console.warn("⚠️ session restore failed:", e.message); }
}
async function backupSession(reason) {
  if (!BACKUP_ON || !isReady) return;
  try {
    let db, wal = null, sig1, sig2, tries = 0;
    do { // read db+wal as a pair; retry if the Go side wrote in between
      const st = (f) => { try { const x = fs.statSync(f); return `${x.size}:${x.mtimeMs}`; } catch { return "-"; } };
      sig1 = st(DB_FILE) + "|" + st(DB_FILE + "-wal");
      db = fs.readFileSync(DB_FILE);
      try { wal = fs.readFileSync(DB_FILE + "-wal"); } catch { wal = null; }
      sig2 = st(DB_FILE) + "|" + st(DB_FILE + "-wal");
    } while (sig1 !== sig2 && ++tries < 4);
    const hash = crypto.createHash("sha256").update(db).update(wal || "").digest("hex");
    if (hash === lastBackupHash) return;
    await axios.post(`${SUPA_URL}/rest/v1/sessions?on_conflict=type,key`,
      { type: "wa_meow", key: "default", data: { db: db.toString("base64"), wal: wal ? wal.toString("base64") : null, savedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      { headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates" }, timeout: 20000 });
    lastBackupHash = hash;
    console.log(`💾 WhatsApp session backed up (${reason}, ${Math.round((db.length + (wal ? wal.length : 0)) / 1024)} KB)`);
  } catch (e) { console.warn("⚠️ session backup failed:", e.message); }
}
async function deleteBackup() {
  if (!BACKUP_ON) return;
  try { await axios.delete(`${SUPA_URL}/rest/v1/sessions?type=eq.wa_meow&key=eq.default`, { headers: supaHeaders(), timeout: 15000 }); lastBackupHash = ""; } catch {}
}

// ── STATE ─────────────────────────────────────────────────────
let client = null, isReady = false, starting = false, currentQR = null, myJid = null, startFailures = 0;
let pairingRequested = false, wmod = null;
const jidByNumber = new Map(); // digits -> chat jid we last saw

const userPart = (jid) => String(jid || "").split("@")[0].split(":")[0];
function requireReady() { if (!client || !isReady) throw new Error("WhatsApp not connected"); }

async function resolveJid(to) {
  const s = String(to || "").trim();
  if (!s) throw new Error("missing 'to'");
  if (s.includes("@")) return s.replace("@c.us", "@s.whatsapp.net");
  const digits = s.replace(/\D/g, "");
  if (jidByNumber.has(digits)) return jidByNumber.get(digits);
  const r = await client.isOnWhatsApp(["+" + digits]);
  const hit = r && r[0];
  if (!hit || !hit.isIn) throw new Error(`${digits} is not on WhatsApp`);
  return hit.jid;
}

async function requestCode(phone) {
  if (!client) throw new Error("Still starting — try again in a few seconds");
  return client.pairCode(phone.replace(/\D/g, ""));
}

// ── PRESENCE + TYPING ─────────────────────────────────────────
const typingLoops = new Map();
let presenceTimer = null, lastOnlineSent = 0;
async function goOnline() {
  if (!client || !isReady) return;
  if (Date.now() - lastOnlineSent > 20000) {
    try { await client.sendPresence("available"); lastOnlineSent = Date.now(); } catch (e) { console.warn("⚠️ presence available failed:", e.message); }
  }
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(goOffline, 60000 + Math.floor(Math.random() * 60000));
}
async function goOffline() {
  if (!client || !isReady) return;
  if (typingLoops.size) { presenceTimer = setTimeout(goOffline, 15000); return; }
  try { await client.sendPresence("unavailable"); lastOnlineSent = 0; } catch (e) { console.warn("⚠️ presence unavailable failed:", e.message); }
}
const pulseTyping = (jid) => client.sendChatPresence(jid, "composing");
function stopTyping(jid, clear = true) {
  const t = typingLoops.get(jid);
  if (t) { clearInterval(t); typingLoops.delete(jid); }
  if (clear && t && client && isReady) client.sendChatPresence(jid, "paused").catch(() => {});
}
function startTyping(jid, maxMs = 90000) {
  stopTyping(jid, false);
  const began = Date.now();
  const t = setInterval(async () => {
    if (!isReady || Date.now() - began > maxMs) return stopTyping(jid);
    try { await pulseTyping(jid); } catch (e) { console.warn(`⚠️ typing refresh failed: ${e.message}`); }
  }, 8000);
  typingLoops.set(jid, t);
}

// ── VOICE (MP3 -> OGG/Opus) ───────────────────────────────────
function toOggOpus(buf) {
  return new Promise((resolve, reject) => {
    const base = path.join(os.tmpdir(), `vn_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(`${base}.in`, buf);
    require("child_process").execFile("ffmpeg",
      ["-y", "-loglevel", "error", "-i", `${base}.in`, "-vn", "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-application", "voip", "-f", "ogg", `${base}.ogg`],
      { timeout: 30000 }, (err) => {
        let out = null, failure = err;
        if (!err) { try { out = fs.readFileSync(`${base}.ogg`); } catch (e) { failure = e; } }
        fs.rm(`${base}.in`, () => {}); fs.rm(`${base}.ogg`, () => {});
        failure ? reject(failure) : resolve(out);
      });
  });
}

// ── INBOUND ───────────────────────────────────────────────────
async function forwardToMainApp(payload) {
  try {
    await axios.post(`${MAIN_APP_URL}/webhook`, payload, { timeout: 30000, headers: API_SECRET ? { "x-wa-secret": API_SECRET } : {} });
    return true;
  } catch (e) { console.error("❌ Forward to main app failed:", e.message); return false; }
}
async function deliverWithRetry(payload, info) {
  for (const wait of [0, 5000, 20000, 60000, 180000]) {
    if (wait) await sleep(wait);
    if (await forwardToMainApp(payload)) {
      try { await client.markRead([info.id], info.chat, info.sender); } catch {}
      return true;
    }
  }
  console.error("❌ Gave up delivering message after retries:", info.id);
  return false;
}

function classify(m) {
  if (m.conversation) return { kind: "text", text: m.conversation };
  if (m.extendedTextMessage && m.extendedTextMessage.text) return { kind: "text", text: m.extendedTextMessage.text };
  if (m.imageMessage) return { kind: "image", caption: m.imageMessage.caption };
  if (m.videoMessage) return { kind: "video", caption: m.videoMessage.caption };
  if (m.audioMessage) return { kind: "audio" };
  if (m.documentMessage) return { kind: "document", caption: m.documentMessage.caption };
  if (m.stickerMessage) return { kind: "sticker" };
  return null; // reactions, protocol messages, etc.
}

function onMessage({ info, message }) {
  try {
    if (info.isFromMe || info.isGroup || String(info.chat).startsWith("status@")) return;
    const c = classify(message || {});
    if (!c) return;
    if (c.kind === "text" && !String(c.text || "").trim()) return;

    const number = userPart(info.sender); // may be a WhatsApp "@lid" id for some contacts
    jidByNumber.set(number, info.chat);
    const msg = { from: number, id: info.id, pushName: info.pushName || null, type: c.kind };
    if (c.kind === "text") msg.text = { body: c.text };
    else if (c.caption) msg[c.kind] = { caption: c.caption };

    goOnline();
    console.log(`📱 WA [whatsmeow] ${info.pushName || number}${String(info.sender).endsWith("@lid") ? " (lid)" : ""}: ${c.kind === "text" ? JSON.stringify(c.text) : `[${c.kind}]`}`);
    deliverWithRetry({ message: msg, _source: "wwebjs" }, info).catch((e) => console.error("❌ deliver:", e.message));
  } catch (e) { console.error("❌ onMessage:", e.message); }
}

// ── OUTBOUND ──────────────────────────────────────────────────
async function sendMedia(jid, body) {
  let buf, mime = "audio/mpeg", kind = "audio", name = "file";
  if (body.base64) buf = Buffer.from(body.base64, "base64");
  else {
    const r = await axios.get(body.url, { responseType: "arraybuffer", timeout: 30000 });
    buf = Buffer.from(r.data);
    mime = String(r.headers["content-type"] || "application/octet-stream").split(";")[0];
    kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
  }
  let ptt = false;
  if (body.voice) {
    try { buf = await toOggOpus(buf); mime = "audio/ogg; codecs=opus"; ptt = true; kind = "audio"; }
    catch (e) { console.warn(`⚠️ voice conversion failed (${e.message}) — sending original`); }
  }
  const tmp = path.join(os.tmpdir(), `wa_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, buf);
  try {
    const up = await client.uploadMedia(tmp, kind);
    const common = { URL: up.URL, directPath: up.directPath, mediaKey: up.mediaKey, fileEncSHA256: up.fileEncSHA256, fileSHA256: up.fileSHA256, fileLength: String(up.fileLength), mimetype: mime };
    const field = { image: "imageMessage", video: "videoMessage", audio: "audioMessage", document: "documentMessage" }[kind];
    const payload = { ...common, ...(kind === "audio" ? { PTT: ptt } : body.caption ? { caption: body.caption } : {}), ...(kind === "document" ? { fileName: name } : {}) };
    await client.sendRawMessage(jid, { [field]: payload });
  } finally { fs.rm(tmp, () => {}); }
}

async function handleApi(pathname, body) {
  requireReady();
  const jid = await resolveJid(body.to);
  if (pathname === "/send") {
    if (!body.message) throw new Error("missing 'message'");
    stopTyping(jid, false);
    await client.sendMessage(jid, { conversation: String(body.message) });
    console.log(`✅ whatsmeow → ${jid}`);
    goOnline();
    return { ok: true };
  }
  if (pathname === "/typing") {
    await goOnline();
    await pulseTyping(jid);
    startTyping(jid);
    return { ok: true };
  }
  if (pathname === "/send-media") {
    if (!body.url && !body.base64) throw new Error("missing 'url' or 'base64'");
    stopTyping(jid, false);
    await sendMedia(jid, body);
    console.log(`✅ whatsmeow ${body.voice ? "voice note" : "media"} → ${jid}`);
    goOnline();
    return { ok: true };
  }
  const e = new Error("not found"); e.status = 404; throw e;
}

async function resetSession() {
  await deleteBackup();
  try { if (client) await client.logout(); } catch {}
  try { if (client) client.close(); } catch {}
  client = null; isReady = false;
  if (!/^postgres/i.test(STORE)) await fs.promises.rm(DATA_PATH, { recursive: true, force: true }).catch(() => {});
  else console.warn("⚠️ Postgres store: logout removed the device. Clear its whatsmeow_* rows only if re-pairing fails.");
  try { fs.mkdirSync(DATA_PATH, { recursive: true }); } catch {}
  setTimeout(start, 1000);
}

// ── ADMIN UI ──────────────────────────────────────────────────
const CSS = `body{background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
h2{color:#25D366;text-align:center}.card{background:#1a1a1a;border-radius:12px;padding:20px;margin:12px 0;width:100%;max-width:360px;box-sizing:border-box}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #333;background:#222;color:#fff;font-size:16px;box-sizing:border-box;margin:8px 0}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#25D366;color:#fff;font-size:16px;margin-top:8px}
a{color:#25D366;display:block;text-align:center;margin-top:8px}p{color:#aaa;text-align:center;font-size:14px}
.code{font-size:44px;font-weight:bold;color:#25D366;letter-spacing:8px;background:#1a1a1a;padding:20px 28px;border-radius:14px;margin:16px 0}
img{width:280px;height:280px;background:#fff;padding:16px;border-radius:12px}`;
const html = (b) => `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>${b}</body></html>`;

async function ui(pathname, params) {
  const keyQ = params.get("key") ? `?key=${encodeURIComponent(params.get("key"))}` : "";
  const keyHidden = params.get("key") ? `<input type="hidden" name="key" value="${esc(params.get("key"))}"/>` : "";
  const back = `<a href="${UI_BASE || "/"}${keyQ}">Back</a>`;
  if (pathname === "/qr") {
    if (isReady) return html(`<h2>Already connected 🟢</h2>${back}`);
    if (!currentQR) return html(`<p>QR not ready yet. Refresh in a few seconds.</p>`);
    const img = await qrcode.toDataURL(currentQR);
    return html(`<h2>Scan QR — Ariana</h2><img src="${img}"/><p>WhatsApp → Linked Devices → Link a Device</p><p style="font-size:12px">Refresh if it expires</p>${back}`);
  }
  if (pathname === "/pair") {
    const phone = (params.get("phone") || PHONE_NUMBER).replace(/\D/g, "");
    if (isReady) return html(`<h2>Already connected 🟢</h2>`);
    if (!phone) return html(`<p style="color:#ff6b6b">Enter a phone number with country code, or set PHONE_NUMBER.</p>${back}`);
    try { const code = await requestCode(phone); return html(`<h2>Pairing Code</h2><div class="code">${esc(code)}</div><p>Ariana's WhatsApp → Linked Devices → Link a Device → Link with phone number instead. Enter this code.</p>`); }
    catch (e) { return html(`<p style="color:#ff6b6b">Error: ${esc(e.message)}</p>${back}`); }
  }
  return html(`<h2>🌸 Ariana — WhatsApp</h2>
    <p style="font-size:20px">${isReady ? "🟢 Connected" : client ? "🟡 Not linked yet" : "🔴 Starting…"}</p>
    <p style="font-size:12px;color:#555">engine: whatsmeow · session: ${/^postgres/i.test(STORE) ? "postgres" : "local disk"}</p>
    ${isReady ? `<div class="card"><p>Ariana is live on WhatsApp 🎉</p></div>` : `
    <div class="card"><h3 style="color:#25D366;margin-top:0">Pairing code</h3>
      <form action="${UI_BASE}/pair" method="get">${keyHidden}
        <input type="tel" name="phone" placeholder="e.g. +12494874637" value="${esc(PHONE_NUMBER)}"/>
        <button type="submit">Get code</button></form></div>
    <div class="card"><h3 style="color:#25D366;margin-top:0">QR code</h3><a href="${UI_BASE}/qr${keyQ}">View QR →</a></div>`}`);
}

// ── HTTP SERVER ───────────────────────────────────────────────
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8e6) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}
const send = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const hasApiAuth = !!API_SECRET && safeEq(bearer, API_SECRET);
  try {
    if (p === "/ping") return send(res, 200, "text/plain", "ok");
    if (req.method === "POST") {
      if (API_SECRET ? !hasApiAuth : EXPOSED) return send(res, 401, "application/json", JSON.stringify({ error: "unauthorized" }));
      const body = await readJson(req);
      if (p === "/pair") {
        if (isReady) return send(res, 200, "application/json", JSON.stringify({ connected: true }));
        const phone = String(body.phone || "").replace(/\D/g, "");
        if (phone.length < 8) { const e = new Error("enter the full number with country code"); e.status = 400; throw e; }
        return send(res, 200, "application/json", JSON.stringify({ ok: true, code: await requestCode(phone) }));
      }
      if (p === "/reset") { await resetSession(); return send(res, 200, "application/json", JSON.stringify({ ok: true })); }
      return send(res, 200, "application/json", JSON.stringify(await handleApi(p, body)));
    }
    if (ADMIN_KEY && !hasApiAuth && !safeEq(url.searchParams.get("key") || "", ADMIN_KEY)) {
      return send(res, 401, "text/html", html(`<p>Unauthorized — add ?key=&lt;WA_ADMIN_KEY&gt;</p>`));
    }
    if (p === "/status") return send(res, 200, "application/json", JSON.stringify({ connected: isReady, hasQR: !!currentQR, mode: /^postgres/i.test(STORE) ? "postgres" : "local", engine: "whatsmeow", number: isReady && myJid ? userPart(myJid) : null }));
    return send(res, 200, "text/html", await ui(p, url.searchParams));
  } catch (e) {
    const code = e.status || (/not connected|still starting/i.test(e.message) ? 503 : 500);
    send(res, code, "application/json", JSON.stringify({ error: e.message }));
  }
});
server.listen(PORT, HOST, () => console.log(`🌐 wa-meow sidecar on ${HOST}:${PORT}${EXPOSED ? " (standalone, secrets required)" : ""}`));

// ── WHATSAPP CLIENT ───────────────────────────────────────────
async function start() {
  if (starting) return;
  starting = true;
  try {
    if (!wmod) wmod = await import("@whatsmeow-node/whatsmeow-node");
    const c = wmod.createClient({ store: STORE });
    client = c; isReady = false; pairingRequested = false;

    c.on("qr", ({ code }) => { currentQR = code; isReady = false; console.log("📱 QR ready — open /wa/qr"); });
    c.on("connected", ({ jid } = {}) => {
      isReady = true; currentQR = null; startFailures = 0; if (jid) myJid = jid;
      goOnline();
      setTimeout(() => backupSession("connected"), 20000);
      if (!global.__waBackupTimer) global.__waBackupTimer = setInterval(() => backupSession("periodic"), 5 * 60 * 1000);
      console.log(`✅ Ariana WhatsApp CONNECTED via whatsmeow (${userPart(myJid) || "?"})`);
    });
    c.on("disconnected", () => { isReady = false; console.log("🔄 Disconnected — whatsmeow auto-reconnects"); });
    c.on("logged_out", ({ reason } = {}) => { isReady = false; console.error(`❌ Logged out (${reason}) — re-pair from /wa`); resetSession(); });
    c.on("temporary_ban", (e) => console.error("🚫 temporary ban:", JSON.stringify(e)));
    c.on("stream_error", (e) => console.warn("⚠️ stream_error:", JSON.stringify(e)));
    c.on("message", onMessage);
    c.on("error", (e) => console.error("⚠️ client error:", e && e.message));

    const init = await c.init();
    if (init.jid) myJid = init.jid;
    if (!init.jid) await c.getQRChannel();
    await c.connect();

    if (!init.jid && PHONE_NUMBER && !pairingRequested) {
      pairingRequested = true;
      setTimeout(() => requestCode(PHONE_NUMBER).then(
        (code) => console.log(`\n══ PAIRING CODE: ${code} ══  (WhatsApp → Linked Devices → Link with phone number)\n`),
        (e) => { pairingRequested = false; console.log("Auto-pair failed:", e.message); }), 3000);
    }
  } catch (e) {
    console.error("❌ start failed:", e.message);
    try { if (client) client.close(); } catch {}
    client = null;
    const wait = Math.min(300000, 10000 * 2 ** Math.min(startFailures++, 5));
    setTimeout(start, wait);
  } finally { starting = false; }
}
restoreBackup().then(start);

const shutdown = async () => {
  try { await Promise.race([backupSession("shutdown"), sleep(8000)]); } catch {}
  try { if (client) client.close(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (r) => console.error("Unhandled:", r));
process.on("uncaughtException", (e) => console.error("Uncaught:", e));
