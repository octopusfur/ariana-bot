"use strict";
/**
 * snapchat.js — Snapchat channel for Ariana, via the unofficial Snapchat Web API sidecar
 * (snapchat-service/, runs as its own Fly.io app, same pattern as the WhatsApp sidecar).
 *
 *   inbound : sidecar polls allowlisted chats -> POST {MAIN_APP_URL}/snapchat/inbound (x-snap-secret)
 *   outbound: sendText / sendImage -> sidecar /send-text | /send-media
 *   setup   : dashboard routes under /api/snapchat/* (sign in or paste a session, add chats)
 *
 * Conversation ids are `sc_<conversation-uuid>`; platform is "snapchat".
 * This is NOT an official Snapchat API: it can break whenever Snapchat changes its web app,
 * and automating an account is against Snapchat's terms. Use a dedicated account.
 *
 * Env: SNAP_SERVICE_URL (https://<app>.fly.dev), SNAP_API_SECRET (shared with the sidecar)
 */
const crypto = require("crypto");
const axios = require("axios");

const state = {
  url: (process.env.SNAP_SERVICE_URL || "").replace(/\/$/, ""),
  secret: process.env.SNAP_API_SECRET || "",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHUNK = 1000;

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const isConfigured = () => !!(state.url && state.secret);
const isConversationId = (v) => UUID_RE.test(String(v || ""));

function sidecarError(e) {
  const msg = e.response?.data?.error || e.message;
  const err = new Error(`Snapchat: ${msg}`);
  err.status = e.response?.status || 502;
  return err;
}

async function call(method, path, data, { timeout = 30000 } = {}) {
  if (!isConfigured()) throw new Error("Snapchat is not configured (SNAP_SERVICE_URL / SNAP_API_SECRET)");
  try {
    const r = await axios({ method, url: state.url + path, data, timeout, headers: { Authorization: `Bearer ${state.secret}` }, validateStatus: () => true });
    if (r.status >= 400) { const e = new Error(r.data?.error || `HTTP ${r.status}`); e.response = r; throw e; }
    return r.data;
  } catch (e) { throw sidecarError(e); }
}

function chunks(text) {
  const s = String(text || "").trim();
  const out = [];
  for (let i = 0; i < s.length; i += MAX_CHUNK) out.push(s.slice(i, i + MAX_CHUNK));
  return out;
}

async function sendText(conversationId, text) {
  if (!isConversationId(conversationId)) throw new Error("Snapchat: invalid conversation id");
  for (const part of chunks(text)) await call("post", "/send-text", { conversation_id: conversationId, text: part });
}

async function sendImage(conversationId, imageUrl, caption) {
  if (!isConversationId(conversationId)) throw new Error("Snapchat: invalid conversation id");
  const img = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 30000, maxContentLength: 20 * 1024 * 1024 });
  const name = (String(imageUrl).split("?")[0].split("/").pop() || "image.jpg").slice(-60);
  await call("post", "/send-media", { conversation_id: conversationId, filename: name, data_b64: Buffer.from(img.data).toString("base64") }, { timeout: 60000 });
  if (caption) await sendText(conversationId, caption);
}

const typing = () => {}; // Snapchat Web has no typing indicator we can drive

/** Wire routes. deps: { app, requireAuth, getSupabase, onMessage({id,platform,from,text,chatId,phoneNumberId,name}) } */
function init(deps) {
  const { app, requireAuth, getSupabase, onMessage } = deps;
  const seen = new Map(); // dedupe retried deliveries

  const persist = async (patch) => {
    const sb = getSupabase();
    if (!sb) return false;
    const { data: cur } = await sb.from("sessions").select("data").eq("type", "snapchat").eq("key", "default").maybeSingle();
    const data = { ...(cur?.data || {}), ...patch };
    const { error } = await sb.from("sessions").upsert({ type: "snapchat", key: "default", data, updated_at: new Date().toISOString() }, { onConflict: "type,key" });
    if (error) { console.warn("[snapchat] could not persist:", error.message); return false; }
    return true;
  };

  /** On boot, hand the saved session to the sidecar so a redeploy never signs her out. */
  async function loadLinked() {
    if (!isConfigured()) { console.log("👻 Snapchat:    — not configured (set SNAP_SERVICE_URL + SNAP_API_SECRET)"); return; }
    const sb = getSupabase();
    try {
      const { data } = sb ? await sb.from("sessions").select("data").eq("type", "snapchat").eq("key", "default").maybeSingle() : { data: null };
      const d = data?.data;
      if (d?.cookies) {
        await call("post", "/session", { cookies: d.cookies, bearer_token: d.bearer_token || "", user_uuid: d.user_uuid || undefined });
        if (d.conversations?.length) await call("post", "/conversations", { replace: d.conversations });
      }
      const st = await call("get", "/status", undefined, { timeout: 8000 });
      console.log(`👻 Snapchat:    ${st.connected ? "✅ connected" : st.signed_in ? "⚠️ signed in, user UUID missing" : "— not signed in"}`);
    } catch (e) { console.warn("[snapchat] could not reach sidecar:", e.message); }
  }

  app.post("/snapchat/inbound", async (req, res) => {
    if (!state.secret || !safeEq(req.get("x-snap-secret") || "", state.secret)) return res.sendStatus(401);
    const conv = String(req.body?.conversation_id || "").toLowerCase();
    const text = String(req.body?.text || "").trim();
    if (!isConversationId(conv) || !text) return res.sendStatus(400);
    res.sendStatus(200);
    const key = `${conv}:${text}`;
    if (seen.has(key) && Date.now() - seen.get(key) < 60000) return;
    seen.set(key, Date.now());
    if (seen.size > 2000) for (const k of [...seen.keys()].slice(0, 1000)) seen.delete(k);
    console.log(`👻 Snapchat ${conv.slice(0, 8)}: ${JSON.stringify(text)}`);
    onMessage({ id: `sc_${conv}`, platform: "snapchat", from: conv, text, chatId: conv, phoneNumberId: null, name: null })
      .catch((e) => console.error("❌ Snapchat handle:", e.message));
  });

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message }); }
  };

  app.get("/api/snapchat/status", requireAuth, wrap(async () => {
    if (!isConfigured()) return { configured: false, connected: false };
    const st = await call("get", "/status", undefined, { timeout: 8000 });
    let saved = null; // is the session stored in Supabase (sessions table, type "snapchat")?
    const sb = getSupabase();
    if (sb) {
      try { const { data } = await sb.from("sessions").select("data").eq("type", "snapchat").eq("key", "default").maybeSingle(); saved = !!(data?.data?.cookies); } catch { saved = null; }
    }
    return { configured: true, ...st, saved };
  }));

  app.post("/api/snapchat/login", requireAuth, wrap(async (req) => {
    const { username, password, userUuid } = req.body || {};
    if (!username || !password) { const e = new Error("username and password required"); e.status = 400; throw e; }
    const r = await call("post", "/login", { username, password, user_uuid: userUuid || undefined });
    const uuid = (userUuid ? String(userUuid).toLowerCase() : r.user_uuid_found) || null;
    const saved = await persist({ cookies: r.cookies, bearer_token: r.bearer_token, ...(uuid ? { user_uuid: uuid } : {}) });
    return { ok: true, saved, connected: r.connected, signed_in: r.signed_in, user_uuid_set: r.user_uuid_set, user_uuid_found: r.user_uuid_found || null };
  }));

  app.post("/api/snapchat/session", requireAuth, wrap(async (req) => {
    const { cookies, bearerToken, userUuid } = req.body || {};
    if (!cookies) { const e = new Error("cookies required (JSON export or name/value object)"); e.status = 400; throw e; }
    const r = await call("post", "/session", { cookies, bearer_token: bearerToken || "", user_uuid: userUuid || undefined });
    const uuid = (userUuid ? String(userUuid).toLowerCase() : r.user_uuid_found) || null;
    const saved = await persist({ cookies: r.cookies, bearer_token: r.bearer_token, ...(uuid ? { user_uuid: uuid } : {}) });
    return { ok: true, saved, connected: r.connected, signed_in: r.signed_in, user_uuid_set: r.user_uuid_set, user_uuid_found: r.user_uuid_found || null };
  }));

  app.post("/api/snapchat/user-uuid", requireAuth, wrap(async (req) => {
    const v = String(req.body?.userUuid || "").toLowerCase();
    if (!isConversationId(v)) { const e = new Error("userUuid must look like 8-4-4-4-12 hex"); e.status = 400; throw e; }
    const r = await call("post", "/session-uuid", { user_uuid: v }).catch(() => null);
    await persist({ user_uuid: v });
    return { ok: true, applied: !!r };
  }));

  app.get("/api/snapchat/conversations", requireAuth, wrap(() => call("get", "/conversations")));
  app.get("/api/snapchat/conversations/candidates", requireAuth, wrap(() => call("get", "/conversations/candidates", undefined, { timeout: 45000 })));
  app.post("/api/snapchat/conversations", requireAuth, wrap(async (req) => {
    const r = await call("post", "/conversations", { add: req.body?.add || [], remove: req.body?.remove || [] });
    await persist({ conversations: r.conversations });
    return r;
  }));

  app.post("/api/snapchat/pause", requireAuth, wrap((req) => call("post", "/pause", { paused: req.body?.paused !== false })));

  app.post("/api/snapchat/unlink", requireAuth, wrap(async () => {
    await call("post", "/logout", {}).catch(() => {});
    const sb = getSupabase();
    if (sb) try { await sb.from("sessions").delete().eq("type", "snapchat").eq("key", "default"); } catch {}
    return { ok: true };
  }));

  // Everything else the library can do, passed straight through (unsupported actions answer 501 with the reason).
  const passthrough = [
    ["get", "/api/snapchat/friends", "/friends"],
    ["get", "/api/snapchat/friend-requests", "/friend-requests"],
    ["post", "/api/snapchat/add-friend", "/add-friend"],
    ["get", "/api/snapchat/feed/stories", "/feed/stories"],
    ["get", "/api/snapchat/feed/spotlight", "/feed/spotlight"],
    ["post", "/api/snapchat/post-story", "/post-story"],
    ["post", "/api/snapchat/like", "/like"],
    ["post", "/api/snapchat/comment", "/comment"],
    ["post", "/api/snapchat/follow", "/follow"],
  ];
  for (const [m, route, target] of passthrough) app[m](route, requireAuth, wrap((req) => call(m, target, m === "post" ? req.body || {} : undefined, { timeout: 45000 })));
  app.get("/api/snapchat/lookup/:id", requireAuth, wrap((req) => {
    if (!isConversationId(req.params.id)) { const e = new Error("id must be a UUID"); e.status = 400; throw e; }
    return call("get", `/lookup/${req.params.id}`);
  }));

  return { loadLinked };
}

module.exports = { init, sendText, sendImage, typing, isConfigured, isConversationId, chunks, getStatus: () => call("get", "/status", undefined, { timeout: 5000 }) };
