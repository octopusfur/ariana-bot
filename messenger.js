"use strict";
/**
 * messenger.js — Facebook Messenger channel for Ariana (official Graph API, Page inbox).
 * Pattern borrowed from zwehtet-dev/auto-reply-bot: verified webhook in, Graph "send" API out.
 *
 *   inbound : Meta -> GET/POST {PUBLIC_URL}/messenger   (X-Hub-Signature-256 verified with the App Secret)
 *   outbound: sendText / sendImage / typing  (Page access token)
 *   setup   : dashboard -> Settings -> Messenger (POST /api/messenger/save), or env FB_PAGE_TOKEN / FB_APP_SECRET / FB_VERIFY_TOKEN
 *
 * Conversation ids are `fb_<PSID>`; platform is "messenger".
 * Meta only lets a Page reply within 24h of the person's last message (standard messaging window).
 */
const crypto = require("crypto");
const axios = require("axios");

const GRAPH = "https://graph.facebook.com/v21.0";
const FIELDS = "messages,messaging_postbacks";

const state = {
  pageToken: process.env.FB_PAGE_TOKEN || "",
  appSecret: process.env.FB_APP_SECRET || "",
  verifyToken: process.env.FB_VERIFY_TOKEN || "",
  pageId: "",
  pageName: "",
};
const seenMids = new Map(); // dedupe: Meta retries deliveries
const names = new Map();    // psid -> display name

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** True only if header is a valid sha256 HMAC of rawBody under secret. Fails closed without a secret. */
function verifySignature(rawBody, header, secret) {
  if (!secret || !rawBody || !header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEq(header, expected);
}

const isConfigured = () => !!state.pageToken;

function graphError(e) {
  const err = e.response?.data?.error;
  if (!err) return new Error(e.message);
  if (err.code === 10 || err.error_subcode === 2018278) return new Error("Outside Messenger's 24-hour reply window — they have to message first");
  return new Error(`Messenger: ${err.message}${err.code ? ` (code ${err.code})` : ""}`);
}

async function graph(method, path, { data, params, token } = {}) {
  try {
    const r = await axios({ method, url: GRAPH + path, data, params, timeout: 20000, headers: { Authorization: `Bearer ${token || state.pageToken}` } });
    return r.data;
  } catch (e) { throw graphError(e); }
}

async function sendText(psid, text) {
  if (!isConfigured()) throw new Error("Messenger is not linked");
  const s = String(text || "");
  for (let i = 0; i < s.length || i === 0; i += 1900) {
    await graph("post", "/me/messages", { data: { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: s.slice(i, i + 1900) } } });
  }
}
async function sendImage(psid, url, caption) {
  if (!isConfigured()) throw new Error("Messenger is not linked");
  await graph("post", "/me/messages", { data: { recipient: { id: psid }, messaging_type: "RESPONSE", message: { attachment: { type: "image", payload: { url, is_reusable: true } } } } });
  if (caption) await sendText(psid, caption);
}
const senderAction = (psid, action) =>
  isConfigured() ? graph("post", "/me/messages", { data: { recipient: { id: psid }, sender_action: action } }).catch(() => {}) : Promise.resolve();
const typing = (psid) => senderAction(psid, "typing_on");

async function displayName(psid) {
  if (names.has(psid)) return names.get(psid);
  try {
    const r = await graph("get", `/${psid}`, { params: { fields: "first_name,last_name" } });
    const n = [r.first_name, r.last_name].filter(Boolean).join(" ") || null;
    names.set(psid, n);
    return n;
  } catch { names.set(psid, null); return null; }
}

function extractEvents(body) {
  const out = [];
  if (!body || body.object !== "page") return out;
  for (const entry of body.entry || []) for (const ev of entry.messaging || []) {
    const psid = ev.sender && ev.sender.id;
    if (!psid || (state.pageId && psid === state.pageId)) continue;
    if (ev.message) {
      if (ev.message.is_echo) continue;
      const mid = ev.message.mid;
      let text = ev.message.text;
      if (!text && ev.message.attachments && ev.message.attachments.length) text = `[${ev.message.attachments[0].type || "attachment"}]`;
      if (text) out.push({ psid, mid, text });
    } else if (ev.postback) {
      const text = ev.postback.title || ev.postback.payload;
      if (text) out.push({ psid, mid: `pb_${psid}_${ev.timestamp}`, text });
    }
  }
  return out;
}

/** Wire routes. deps: { app, requireAuth, getSupabase, onMessage({id,platform,from,text,chatId,phoneNumberId,name}) } */
function init(deps) {
  const { app, requireAuth, getSupabase, onMessage } = deps;

  const persist = async () => {
    const sb = getSupabase();
    if (!sb) return false;
    const { error } = await sb.from("sessions").upsert(
      { type: "messenger", key: "default", data: { pageToken: state.pageToken, appSecret: state.appSecret, verifyToken: state.verifyToken, pageId: state.pageId, pageName: state.pageName }, updated_at: new Date().toISOString() },
      { onConflict: "type,key" });
    if (error) { console.warn("[messenger] could not persist:", error.message); return false; }
    return true;
  };

  async function loadLinked() {
    const sb = getSupabase();
    if (sb) {
      try {
        const { data } = await sb.from("sessions").select("data").eq("type", "messenger").eq("key", "default").maybeSingle();
        if (data && data.data && data.data.pageToken) Object.assign(state, data.data);
      } catch (e) { console.warn("[messenger] could not load linked page:", e.message); }
    }
    if (state.pageToken && !state.pageId) {
      try { const me = await graph("get", "/me", { params: { fields: "id,name" } }); state.pageId = me.id; state.pageName = me.name; }
      catch (e) { console.warn("[messenger] page token check failed:", e.message); }
    }
    console.log(`💬 Messenger:   ${isConfigured() ? `✅ ${state.pageName || "page linked"}${state.appSecret ? "" : " (⚠️ no app secret — webhook will reject)"}` : "— not linked (dashboard → Settings → Messenger)"}`);
  }

  // Webhook verification handshake
  app.get("/messenger", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && state.verifyToken && safeEq(req.query["hub.verify_token"] || "", state.verifyToken)) {
      return res.status(200).send(String(req.query["hub.challenge"] || ""));
    }
    res.sendStatus(403);
  });

  // Inbound messages
  app.post("/messenger", async (req, res) => {
    if (!verifySignature(req.rawBody, req.get("x-hub-signature-256"), state.appSecret)) return res.sendStatus(401);
    res.sendStatus(200); // ack first; Meta retries slow endpoints
    try {
      for (const ev of extractEvents(req.body)) {
        if (ev.mid) {
          if (seenMids.has(ev.mid)) continue;
          seenMids.set(ev.mid, Date.now());
          if (seenMids.size > 2000) for (const k of [...seenMids.keys()].slice(0, 1000)) seenMids.delete(k);
        }
        senderAction(ev.psid, "mark_seen");
        const name = await displayName(ev.psid);
        console.log(`💬 Messenger ${name || ev.psid}: ${JSON.stringify(ev.text)}`);
        onMessage({ id: `fb_${ev.psid}`, platform: "messenger", from: ev.psid, text: ev.text, chatId: ev.psid, phoneNumberId: null, name })
          .catch((e) => console.error("❌ Messenger handle:", e.message));
      }
    } catch (e) { console.error("❌ Messenger webhook:", e.message); }
  });

  const baseUrl = (req) => `https://${req.get("x-forwarded-host") || req.get("host")}`;

  app.get("/api/messenger/status", requireAuth, (req, res) => {
    res.json({ configured: isConfigured(), pageName: state.pageName || null, pageId: state.pageId || null, hasAppSecret: !!state.appSecret,
      webhookUrl: `${baseUrl(req)}/messenger`, verifyToken: state.verifyToken || null });
  });

  app.post("/api/messenger/save", requireAuth, async (req, res) => {
    const pageToken = String(req.body?.pageToken || "").trim();
    const appSecret = String(req.body?.appSecret || "").trim();
    const appId = String(req.body?.appId || "").replace(/\D/g, "");
    if (!pageToken || !appSecret) return res.status(400).json({ error: "Paste the Page access token and the App secret" });
    try {
      const me = await graph("get", "/me", { token: pageToken, params: { fields: "id,name" } });
      Object.assign(state, { pageToken, appSecret, pageId: me.id, pageName: me.name, verifyToken: state.verifyToken || crypto.randomBytes(12).toString("hex") });
      await graph("post", "/me/subscribed_apps", { data: { subscribed_fields: FIELDS } }); // page -> app
      let webhook = "manual";
      if (appId) { // app -> our URL, so there is nothing to paste into Meta's dashboard
        try {
          await axios.post(`${GRAPH}/${appId}/subscriptions`, null, { timeout: 20000, params: { object: "page", callback_url: `${baseUrl(req)}/messenger`, verify_token: state.verifyToken, fields: FIELDS, access_token: `${appId}|${appSecret}` } });
          webhook = "set";
        } catch (e) { webhook = `failed: ${graphError(e).message}`; }
      }
      const saved = await persist();
      res.json({ ok: true, pageName: me.name, saved, webhook, webhookUrl: `${baseUrl(req)}/messenger`, verifyToken: state.verifyToken });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/messenger/unlink", requireAuth, async (_req, res) => {
    Object.assign(state, { pageToken: "", appSecret: "", pageId: "", pageName: "" });
    const sb = getSupabase();
    if (sb) try { await sb.from("sessions").delete().eq("type", "messenger").eq("key", "default"); } catch {}
    res.json({ ok: true });
  });

  return { loadLinked };
}

module.exports = { init, sendText, sendImage, typing, isConfigured, verifySignature, extractEvents, getStatus: () => ({ configured: isConfigured(), pageName: state.pageName || null, hasAppSecret: !!state.appSecret }) };
