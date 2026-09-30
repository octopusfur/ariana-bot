"use strict";
/**
 * WaCalls adapter. This process deliberately runs beside (not instead of)
 * wa-web.js. It connects Ariana to one WaCalls session, relays SSE lifecycle and
 * optional chat events to index.js, and exposes a small stable API to the app.
 *
 * The upstream WaCalls release currently supplies call signalling/media and a
 * browser WebRTC bridge. Some forks additionally emit `message` events and
 * implement the session `/messages` route; this adapter supports both without
 * coupling Ariana to a particular fork.
 */
const http = require("http");
const axios = require("axios");

const PORT = Number(process.env.WACALLS_ADAPTER_PORT || 3002);
const BASE = (process.env.WACALLS_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const MAIN = (process.env.MAIN_APP_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const SESSION = process.env.WACALLS_SESSION_ID || "ariana";
const ENABLED = /^(1|true|yes|on)$/i.test(process.env.WACALLS_ENABLED || "false");
const AUTO_ANSWER = !/^(0|false|no|off)$/i.test(process.env.WACALLS_AUTO_ANSWER || "true");
const API_KEY = process.env.WACALLS_API_KEY || "";
const CLIENT_ID = process.env.WACALLS_CLIENT_ID || "ariana-ai";
const MESSAGE_PATH = process.env.WACALLS_MESSAGE_PATH || `/api/sessions/${encodeURIComponent(SESSION)}/messages`;
const headers = () => ({ ...(API_KEY ? { "X-API-Key": API_KEY } : {}), "X-Client-Id": CLIENT_ID });

let state = { enabled: ENABLED, connected: false, sessionId: SESSION, lastEvent: null, error: null };
let stopped = false;
const activeCalls = new Map();
const wait = ms => new Promise(r => setTimeout(r, ms));

async function api(method, route, data) {
  return (await axios({ method, url: BASE + route, data, headers: headers(), timeout: 20000 })).data;
}
async function notify(path, body) {
  try { return (await axios.post(MAIN + path, body, { timeout: 120000 })).data; }
  catch (e) { console.error(`[WaCalls] Ariana callback ${path} failed:`, e.response?.data?.error || e.message); return null; }
}
function eventName(evt) { return String(evt.type || evt.event || evt.kind || "unknown").toLowerCase(); }
function callId(evt) { return evt.callId || evt.call_id || evt.call?.id || evt.id; }

async function handleEvent(evt) {
  const type = eventName(evt);
  state.lastEvent = { type, at: new Date().toISOString() };
  // Ignore other accounts if the WaCalls server happens to host more than one.
  const eventSession = evt.sessionId || evt.session_id;
  if (eventSession && String(eventSession) !== SESSION) return;
  if (type === 'auth-state') {
    state.connected = /connected|ready/i.test(String(evt.state || ''));
    state.paired = !!evt.paired;
    console.log(`[WaCalls] auth ${evt.state || 'unknown'} (${SESSION})`);
  } else if (/connected|session.*ready/.test(type) && !/call/.test(type)) {
    state.connected = true; state.error = null; console.log(`[WaCalls] connected (${SESSION})`);
  }
  if (/disconnected|logged.?out/.test(type)) { state.connected = false; console.warn(`[WaCalls] disconnected (${SESSION})`); }

  // Chat is an extension implemented by chat-capable WaCalls builds.
  if (/message/.test(type) && !/message.*sent/.test(type)) {
    const m = evt.message || evt.data || evt;
    if (m.fromMe || m.from_me) return;
    const text = m.text?.body || m.text || m.body || m.caption || m.media?.caption;
    if (!text) return;
    console.log(`[WaCalls] incoming message from ${m.from || m.sender}`);
    await notify("/integrations/wacalls/message", { message: m, sessionId: SESSION });
    return;
  }

  const status = String(evt.status || evt.call?.status || '').toLowerCase();
  if (type === 'incoming' || /incoming.*call|call.*offer|call_offer/.test(type) || (type === 'call-status' && /incoming|ringing/.test(status))) {
    const id = callId(evt);
    if (!id) return;
    const video = !!(evt.video || evt.isVideo || evt.call?.video || evt.media === "video");
    const isNew = !activeCalls.has(id);
    activeCalls.set(id, { id, video, state: "ringing", peer: evt.from || evt.phone || evt.peer || evt.call?.peer });
    if (!isNew) return;
    console.log(`[WaCalls] incoming ${video ? "video" : "audio"} call ${id}`);
    await notify("/integrations/wacalls/event", { type: "incoming_call", callId: id, video, event: evt });
    if (AUTO_ANSWER) {
      try { await api("post", `/api/sessions/${encodeURIComponent(SESSION)}/calls/${encodeURIComponent(id)}/accept`, {}); console.log(`[WaCalls] answered ${id}`); }
      catch (e) { console.error(`[WaCalls] answer ${id} failed:`, e.response?.data?.error || e.message); }
    }
  } else if ((/active|answered|accepted|connected/.test(type) && /call/.test(type)) || (type === 'call-status' && /active|answered|connected/.test(status))) {
    const id = callId(evt); if (id && activeCalls.has(id)) activeCalls.get(id).state = "active";
    await notify("/integrations/wacalls/event", { type: "call_answered", callId: id, event: evt });
  } else if (/terminate|ended|rejected|call_end/.test(type)) {
    const id = callId(evt); if (id) activeCalls.delete(id);
    await notify("/integrations/wacalls/event", { type: "call_ended", callId: id, event: evt });
  }
}

async function consumeSSE() {
  let delay = 1000;
  while (!stopped && ENABLED) {
    try {
      const res = await axios.get(BASE + "/api/events", { headers: { ...headers(), Accept: "text/event-stream" }, responseType: "stream", timeout: 0 });
      state.error = null; delay = 1000;
      let buffer = "";
      res.data.on("data", chunk => {
        buffer += chunk.toString();
        const records = buffer.split(/\r?\n\r?\n/); buffer = records.pop();
        for (const record of records) {
          const raw = record.split(/\r?\n/).filter(x => x.startsWith("data:")).map(x => x.slice(5).trim()).join("\n");
          if (raw) { try { handleEvent(JSON.parse(raw)).catch(e => console.error("[WaCalls] event:", e.message)); } catch (_) {} }
        }
      });
      await new Promise(resolve => { res.data.once("end", resolve); res.data.once("error", resolve); });
    } catch (e) { state.connected = false; state.error = e.message; console.error("[WaCalls] SSE disconnected:", e.message); }
    await wait(delay); delay = Math.min(delay * 2, 30000);
  }
}
function readJson(req) { return new Promise((resolve, reject) => { let s=""; req.on("data", c => { s+=c; if(s.length>15e6) reject(new Error("body too large")); }); req.on("end",()=>{try{resolve(s?JSON.parse(s):{});}catch(e){reject(e);}}); req.on("error",reject); }); }
function json(res, code, value) { res.writeHead(code,{"content-type":"application/json"}); res.end(JSON.stringify(value)); }

http.createServer(async (req,res) => {
  const url = new URL(req.url,"http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/status") return json(res,200,{...state,calls:[...activeCalls.values()]});
    if (req.method !== "POST") return json(res,404,{error:"not found"});
    const body = await readJson(req);
    if (url.pathname === "/send") return json(res,200,await api("post",MESSAGE_PATH,{to:body.to,phone:body.to,text:body.message,message:body.message}));
    if (url.pathname === "/call") return json(res,200,await api("post",`/api/sessions/${encodeURIComponent(SESSION)}/calls`,{phone:body.to,video:!!body.video}));
    const m=url.pathname.match(/^\/calls\/([^/]+)\/(answer|reject|end)$/);
    if (m) {
      const route=`/api/sessions/${encodeURIComponent(SESSION)}/calls/${encodeURIComponent(m[1])}`;
      const result=m[2]==="end"?await api("delete",route):await api("post",`${route}/${m[2]==="answer"?"accept":"reject"}`,{});
      return json(res,200,result||{ok:true});
    }
    return json(res,404,{error:"not found"});
  } catch(e) { json(res,e.response?.status||500,{error:e.response?.data?.error||e.message}); }
}).listen(PORT,"127.0.0.1",()=>console.log(`[WaCalls] adapter on 127.0.0.1:${PORT} (${ENABLED?"enabled":"disabled"})`));
if (ENABLED) consumeSSE(); else console.log("[WaCalls] set WACALLS_ENABLED=true to connect; existing WhatsApp remains unchanged");
process.on("SIGTERM",()=>{stopped=true;process.exit(0);});
