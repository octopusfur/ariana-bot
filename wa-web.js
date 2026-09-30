"use strict";
/**
 * wa-web.js — Ariana's WhatsApp text channel via whatsapp-web.js
 * (replaces the old Baileys sidecar). Runs next to index.js.
 *
 *   inbound : WhatsApp -> POST {MAIN_APP_URL}/webhook   (same shape index.js already parses)
 *   outbound: index.js -> POST http://127.0.0.1:{WA_WEB_PORT}/send | /typing | /send-media
 *   admin UI: GET /  /qr  /pair?phone=  (index.js exposes them publicly under /wa, gated by WA_ADMIN_KEY)
 *
 * Env:
 *   PHONE_NUMBER               Ariana's number with country code -> auto pairing code instead of QR
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *                              session is backed up to a private Supabase Storage bucket, so it
 *                              survives Render redeploys. Without them it falls back to local disk.
 *   WA_PROXY                   optional http(s)://user:pass@host:port for Chromium. Unset = direct.
 *   WA_DATA_DIR, WA_SESSION_BUCKET, WA_CLIENT_ID, WA_WEB_PORT, MAIN_APP_URL   (all optional)
 *   PUPPETEER_EXECUTABLE_PATH  set by the Dockerfile (system Chromium)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const axios = require("axios");
const qrcode = require("qrcode");
const ws = require("ws");
const { createClient } = require("@supabase/supabase-js");
const { Client, RemoteAuth, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const PORT = Number(process.env.WA_WEB_PORT || 3001);
const MAIN_APP_URL = (process.env.MAIN_APP_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/\D/g, "");
const CLIENT_ID = process.env.WA_CLIENT_ID || "ariana";
const DATA_PATH = path.resolve(process.env.WA_DATA_DIR || "./.wwebjs_auth");
const BUCKET = process.env.WA_SESSION_BUCKET || "wwebjs-session";
const UI_BASE = "/wa";

// ── STATE ─────────────────────────────────────────────────────
let client = null;
let isReady = false;
let starting = false;
let currentQR = null;
let lastCode = null;
let pairingRequested = false;
let authMode = "unknown";
let sessionStore = null; // Supabase-backed store (remote mode only)
const jidByNumber = new Map(); // digits -> chat id we last saw (keeps @lid chats replyable)

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── SESSION STORE (Supabase Storage) ──────────────────────────
function makeSupabaseStore(sb) {
  const file = (s) => `${s}.zip`;
  return {
    async sessionExists({ session }) {
      const { data, error } = await sb.storage.from(BUCKET).list("", { search: file(session), limit: 5 });
      if (error) throw error;
      return !!(data && data.some((o) => o.name === file(session)));
    },
    async save({ session }) {
      const buf = await fs.promises.readFile(path.join(DATA_PATH, file(session)));
      const { error } = await sb.storage.from(BUCKET).upload(file(session), buf, { upsert: true, contentType: "application/zip" });
      if (error) throw error;
    },
    async extract({ session, path: outPath }) {
      const { data, error } = await sb.storage.from(BUCKET).download(file(session));
      if (error) throw error;
      await fs.promises.writeFile(outPath, Buffer.from(await data.arrayBuffer()));
    },
    async delete({ session }) {
      const { error } = await sb.storage.from(BUCKET).remove([file(session)]);
      if (error) throw error;
    },
  };
}

async function initAuth() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const sb = createClient(url, key, { auth: { persistSession: false }, realtime: { transport: ws } });
    const { error } = await sb.storage.createBucket(BUCKET, { public: false });
    if (error && !/already exists|duplicate/i.test(error.message || "") && error.statusCode !== "409") {
      console.warn("⚠️  Could not create session bucket:", error.message);
    }
    sessionStore = makeSupabaseStore(sb);
    authMode = "remote";
  } else {
    authMode = "local";
    console.warn("⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — session kept on local disk and is LOST on redeploy unless WA_DATA_DIR is a persistent disk.");
  }
}

const makeAuthStrategy = () =>
  authMode === "remote"
    ? new RemoteAuth({ clientId: CLIENT_ID, dataPath: DATA_PATH, store: sessionStore, backupSyncIntervalMs: 5 * 60 * 1000 })
    : new LocalAuth({ clientId: CLIENT_ID, dataPath: DATA_PATH });

// ── HELPERS ───────────────────────────────────────────────────
function requireReady() {
  if (!client || !isReady) throw new Error("WhatsApp not connected");
}

async function resolveJid(to) {
  const s = String(to || "").trim();
  if (!s) throw new Error("missing 'to'");
  if (s.includes("@")) return s.replace("@s.whatsapp.net", "@c.us");
  const digits = s.replace(/\D/g, "");
  if (jidByNumber.has(digits)) return jidByNumber.get(digits);
  const id = await client.getNumberId(digits);
  if (!id) throw new Error(`${digits} is not on WhatsApp`);
  return id._serialized;
}

async function requestCode(phone) {
  requireClient();
  const code = await client.requestPairingCode(phone.replace(/\D/g, ""));
  lastCode = code;
  return code;
}
function requireClient() {
  if (!client) throw new Error("Browser is still starting — try again in a few seconds");
}

// ── INBOUND ───────────────────────────────────────────────────
const TYPE_MAP = { chat: "text", image: "image", video: "video", ptt: "audio", audio: "audio", document: "document", sticker: "sticker" };

async function forwardToMainApp(payload) {
  try {
    await axios.post(`${MAIN_APP_URL}/webhook`, payload, { timeout: 30000 });
  } catch (e) {
    console.error("❌ Forward to main app failed:", e.message);
  }
}

async function onMessage(msg) {
  try {
    if (msg.fromMe || msg.isStatus || msg.from === "status@broadcast" || String(msg.from).endsWith("@g.us")) return;
    const kind = TYPE_MAP[msg.type];
    if (!kind) return; // reactions, calls log, protocol messages, etc.

    let contact = null;
    try { contact = await msg.getContact(); } catch {}
    const number = (contact && contact.number) || String(msg.from).split("@")[0];
    const name = (contact && (contact.pushname || contact.name)) || (msg._data && msg._data.notifyName) || null;
    jidByNumber.set(number, msg.from);

    const message = { from: number, id: msg.id && msg.id._serialized, pushName: name, type: kind };
    if (kind === "text") {
      if (!String(msg.body || "").trim()) return;
      message.text = { body: msg.body };
    } else if (msg.body && ["image", "video", "document"].includes(kind)) {
      message[kind] = { caption: msg.body };
    }

    console.log(`📱 WA [wwebjs] ${name || number}: ${kind === "text" ? JSON.stringify(msg.body) : `[${kind}]`}`);
    try { const chat = await msg.getChat(); await chat.sendSeen(); } catch {}
    await forwardToMainApp({ message, _source: "wwebjs" });
  } catch (e) {
    console.error("❌ onMessage:", e.message);
  }
}

// ── OUTBOUND (called by index.js on localhost) ────────────────
async function handleApi(pathname, body) {
  requireReady();
  const jid = await resolveJid(body.to);
  if (pathname === "/send") {
    if (!body.message) throw new Error("missing 'message'");
    await client.sendMessage(jid, String(body.message));
    console.log(`✅ wwebjs → ${jid}`);
    return { ok: true };
  }
  if (pathname === "/typing") {
    const chat = await client.getChatById(jid);
    await chat.sendStateTyping();
    return { ok: true };
  }
  if (pathname === "/send-media") {
    if (!body.url) throw new Error("missing 'url'");
    const media = await MessageMedia.fromUrl(body.url, { unsafeMime: true });
    await client.sendMessage(jid, media, { caption: body.caption || undefined, sendAudioAsVoice: !!body.voice });
    console.log(`✅ wwebjs media → ${jid}`);
    return { ok: true };
  }
  const e = new Error("not found");
  e.status = 404;
  throw e;
}

async function resetSession() {
  try { if (client) await client.logout(); } catch {}
  try { if (sessionStore) await sessionStore.delete({ session: `RemoteAuth-${CLIENT_ID}` }); } catch {}
  await fs.promises.rm(DATA_PATH, { recursive: true, force: true }).catch(() => {});
}

// ── ADMIN UI ──────────────────────────────────────────────────
const CSS = `body{background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
h2{color:#25D366;text-align:center}.card{background:#1a1a1a;border-radius:12px;padding:20px;margin:12px 0;width:100%;max-width:360px;box-sizing:border-box}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #333;background:#222;color:#fff;font-size:16px;box-sizing:border-box;margin:8px 0}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#25D366;color:#fff;font-size:16px;margin-top:8px}
a{color:#25D366;display:block;text-align:center;margin-top:8px}p{color:#aaa;text-align:center;font-size:14px}
.code{font-size:44px;font-weight:bold;color:#25D366;letter-spacing:8px;background:#1a1a1a;padding:20px 28px;border-radius:14px;margin:16px 0}
img{width:280px;height:280px;background:#fff;padding:16px;border-radius:12px}`;
const html = (body) => `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`;

async function ui(pathname, params) {
  const keyQ = params.get("key") ? `?key=${encodeURIComponent(params.get("key"))}` : "";
  const keyHidden = params.get("key") ? `<input type="hidden" name="key" value="${esc(params.get("key"))}"/>` : "";

  if (pathname === "/qr") {
    if (isReady) return html(`<h2>Already connected 🟢</h2><a href="${UI_BASE}${keyQ}">Back</a>`);
    if (!currentQR) return html(`<p>QR not ready yet. Refresh in a few seconds.</p>`);
    const img = await qrcode.toDataURL(currentQR);
    return html(`<h2>Scan QR — Ariana</h2><img src="${img}"/><p>WhatsApp → Linked Devices → Link a Device</p><p style="font-size:12px">Refresh if it expires</p><a href="${UI_BASE}${keyQ}">Back</a>`);
  }

  if (pathname === "/pair") {
    const phone = (params.get("phone") || PHONE_NUMBER).replace(/\D/g, "");
    if (isReady) return html(`<h2>Already connected 🟢</h2>`);
    if (!phone) return html(`<p style="color:#ff6b6b">Enter a phone number with country code, or set PHONE_NUMBER.</p><a href="${UI_BASE}${keyQ}">Back</a>`);
    try {
      const code = await requestCode(phone);
      return html(`<h2>Pairing Code</h2><div class="code">${esc(code)}</div><p>Ariana's WhatsApp → Linked Devices → Link a Device → Link with phone number instead. Enter this code.</p>`);
    } catch (e) {
      return html(`<p style="color:#ff6b6b">Error: ${esc(e.message)}</p><a href="${UI_BASE}${keyQ}">Back</a>`);
    }
  }

  return html(`<h2>🌸 Ariana — WhatsApp</h2>
    <p style="font-size:20px">${isReady ? "🟢 Connected" : client ? "🟡 Not linked yet" : "🔴 Starting browser…"}</p>
    <p style="font-size:12px;color:#555">session: ${esc(authMode)}</p>
    ${isReady ? `<div class="card"><p>Ariana is live on WhatsApp 🎉</p></div>` : `
    <div class="card"><h3 style="color:#25D366;margin-top:0">Pairing code</h3>
      <form action="${UI_BASE}/pair" method="get">${keyHidden}
        <input type="tel" name="phone" placeholder="e.g. +12494874637" value="${esc(PHONE_NUMBER)}"/>
        <button type="submit">Get code</button></form></div>
    <div class="card"><h3 style="color:#25D366;margin-top:0">QR code</h3><a href="${UI_BASE}/qr${keyQ}">View QR →</a></div>`}`);
}

// ── HTTP SERVER (localhost only; index.js proxies the UI) ─────
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}
const send = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "POST") {
      const body = await readJson(req);
      if (p === "/reset") { await resetSession(); return send(res, 200, "application/json", JSON.stringify({ ok: true })); }
      const out = await handleApi(p, body);
      return send(res, 200, "application/json", JSON.stringify(out));
    }
    if (p === "/ping") return send(res, 200, "text/plain", "ok");
    if (p === "/status") return send(res, 200, "application/json", JSON.stringify({ connected: isReady, hasQR: !!currentQR, mode: authMode }));
    return send(res, 200, "text/html", await ui(p, url.searchParams));
  } catch (e) {
    const code = e.status || (/not connected/i.test(e.message) ? 503 : 500);
    send(res, code, "application/json", JSON.stringify({ error: e.message }));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`🌐 wa-web sidecar on 127.0.0.1:${PORT}`));

// ── WHATSAPP CLIENT ───────────────────────────────────────────
function puppeteerConfig() {
  const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--mute-audio", "--no-first-run"];
  let proxyAuthentication;
  if (process.env.WA_PROXY) {
    try {
      const u = new URL(process.env.WA_PROXY);
      args.push(`--proxy-server=${u.protocol}//${u.host}`);
      if (u.username) proxyAuthentication = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    } catch { console.warn("⚠️  WA_PROXY is not a valid URL — ignoring"); }
  }
  return {
    puppeteer: { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args },
    proxyAuthentication,
  };
}

async function start() {
  if (starting) return;
  starting = true;
  try {
    if (authMode === "unknown") await initAuth();
    const { puppeteer, proxyAuthentication } = puppeteerConfig();
    const c = new Client({ authStrategy: makeAuthStrategy(), puppeteer, proxyAuthentication });
    client = c;
    isReady = false;
    pairingRequested = false;

    c.on("qr", (qr) => {
      currentQR = qr;
      isReady = false;
      console.log("📱 QR ready — open /wa/qr");
      if (PHONE_NUMBER && !pairingRequested) {
        pairingRequested = true;
        setTimeout(() => requestCode(PHONE_NUMBER).then(
          (code) => console.log(`\n══ PAIRING CODE: ${code} ══  (WhatsApp → Linked Devices → Link with phone number)\n`),
          (e) => { pairingRequested = false; console.log("Auto-pair failed:", e.message); }
        ), 2000);
      }
    });
    c.on("code", (code) => { lastCode = code; });
    c.on("authenticated", () => console.log("🔐 authenticated"));
    c.on("auth_failure", (m) => console.error("❌ auth failure:", m));
    c.on("remote_session_saved", () => console.log("💾 session backed up to Supabase"));
    c.on("ready", () => {
      isReady = true; currentQR = null; lastCode = null;
      console.log(`✅ Ariana WhatsApp CONNECTED via whatsapp-web.js (${c.info && c.info.wid ? c.info.wid.user : "?"})`);
    });
    c.on("disconnected", async (reason) => {
      console.log(`🔄 Disconnected (${reason}) — restarting in 5s`);
      isReady = false;
      try { await c.destroy(); } catch {}
      if (client === c) client = null;
      setTimeout(start, 5000);
    });
    c.on("message", onMessage);

    await c.initialize();
  } catch (e) {
    console.error("❌ start failed:", e.message);
    try { if (client) await client.destroy(); } catch {}
    client = null;
    setTimeout(start, 10000);
  } finally {
    starting = false;
  }
}

start();

const shutdown = async () => {
  try { if (client) await Promise.race([client.destroy(), new Promise((r) => setTimeout(r, 8000))]); } catch {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (r) => console.error("Unhandled:", r));
process.on("uncaughtException", (e) => console.error("Uncaught:", e));
