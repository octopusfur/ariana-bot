"use strict";
/**
 * stickers.js — Ariana's sticker drawer.
 *  • Learns every sticker her owner sends her (bytes + a short description from vision), kept in Supabase.
 *  • After some WhatsApp replies she follows up with a sticker that fits the moment (rarely, never twice in a row).
 * Stored in the Supabase `sessions` table: type = wa_sticker, key = sha1 of the sticker bytes.
 */
const crypto = require("crypto");
const openai = require("./llm_openai");

const MAX_STICKERS = 80;
const COOLDOWN_REPLIES = 4;   // at least this many replies between stickers in a chat
const CHANCE = 0.35;          // then only this often

const lib = new Map();        // id -> { id, base64, mimetype, animated, label, mood, addedAt }
const repliesSince = new Map(); // chat -> replies since the last sticker
let supabase = null;
let rand = Math.random;

function configure({ supabase: sb, random } = {}) { supabase = sb || null; if (random) rand = random; }
const size = () => lib.size;
const list = () => [...lib.values()].map(({ id, label, mood }) => ({ id, label, mood }));

async function load() {
  if (!supabase) return 0;
  try {
    const { data } = await supabase.from("sessions").select("key,data").eq("type", "wa_sticker");
    for (const r of data || []) if (r.data && r.data.base64) lib.set(r.key, { id: r.key, ...r.data });
    return lib.size;
  } catch (e) { console.warn("[stickers] could not load:", e.message); return lib.size; }
}

function firstJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Ask the vision model what this sticker is for. Never throws. */
async function describe(base64, mimetype = "image/webp", { complete = openai.complete, apiKey = process.env.OPENAI_API_KEY } = {}) {
  if (!apiKey) return { label: "sticker", mood: "" };
  try {
    const msg = await complete({
      apiKey, effort: "low", maxOutputTokens: 300, temperature: 0.2, models: ["gpt-6-luna", "gpt-6-sol"],
      sys: "You catalogue WhatsApp stickers so a chat persona can pick one later. Reply with JSON only: {\"label\":\"<max 8 words: what it shows>\",\"mood\":\"<2-4 words: when to use it, e.g. teasing, celebrating, shocked, sleepy>\"}",
      history: [{ role: "user", content: [{ type: "text", text: "Describe this sticker." }, { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } }] }],
    });
    const j = firstJson(msg && msg.content);
    return { label: String((j && j.label) || "sticker").slice(0, 80), mood: String((j && j.mood) || "").slice(0, 60) };
  } catch (e) { console.warn("[stickers] describe failed:", e.message); return { label: "sticker", mood: "" }; }
}

/** Learn a sticker. Returns the entry (existing one if we already had it). */
async function add({ base64, mimetype = "image/webp", animated = false }, deps = {}) {
  if (!base64) return null;
  const id = crypto.createHash("sha1").update(base64).digest("hex").slice(0, 20);
  if (lib.has(id)) return lib.get(id);
  if (lib.size >= MAX_STICKERS) return null;
  const { label, mood } = await describe(base64, mimetype, deps);
  const entry = { id, base64, mimetype, animated: !!animated, label, mood, addedAt: new Date().toISOString() };
  lib.set(id, entry);
  if (supabase) {
    try { await supabase.from("sessions").upsert({ type: "wa_sticker", key: id, data: { base64, mimetype, animated: !!animated, label, mood, addedAt: entry.addedAt }, updated_at: entry.addedAt }, { onConflict: "type,key" }); }
    catch (e) { console.warn("[stickers] could not save:", e.message); }
  }
  console.log(`[stickers] learned: ${label}${mood ? ` (${mood})` : ""} — ${lib.size} in the drawer`);
  return entry;
}

/** Cheap gate: is this a moment where she might send one? */
function shouldTry(chat) {
  if (!lib.size) return false;
  const n = (repliesSince.get(chat) || 0) + 1;
  repliesSince.set(chat, n);
  return n > COOLDOWN_REPLIES && rand() < CHANCE;
}

/** Let the model pick a fitting sticker, or none. */
async function choose({ userText, replyText }, { complete = openai.complete, apiKey = process.env.OPENAI_API_KEY } = {}) {
  if (!lib.size || !apiKey) return null;
  const options = list().map((s) => `${s.id}: ${s.label}${s.mood ? ` (${s.mood})` : ""}`).join("\n");
  try {
    const msg = await complete({
      apiKey, effort: "low", maxOutputTokens: 200, temperature: 0.4, models: ["gpt-6-luna", "gpt-6-sol"],
      sys: "You choose a WhatsApp sticker to follow a chat reply. Pick one only if it clearly fits the mood of the exchange; otherwise none. Reply with JSON only: {\"id\":\"<sticker id>\"} or {\"id\":null}.",
      history: [{ role: "user", content: `They said: ${String(userText || "").slice(0, 300)}\nShe replied: ${String(replyText || "").slice(0, 300)}\n\nStickers:\n${options}` }],
    });
    const j = firstJson(msg && msg.content);
    return j && j.id && lib.has(j.id) ? lib.get(j.id) : null;
  } catch (e) { console.warn("[stickers] choose failed:", e.message); return null; }
}

/** Call after a text reply. send(stickerEntry) delivers it. Resets the cooldown when one is sent. */
async function maybeFollowUp({ chat, userText, replyText, send, deps }) {
  if (!shouldTry(chat)) return false;
  const pick = await choose({ userText, replyText }, deps);
  if (!pick) return false;
  try { await send(pick); repliesSince.set(chat, 0); return true; }
  catch (e) { console.warn("[stickers] send failed:", e.message); return false; }
}

module.exports = { configure, load, add, describe, choose, shouldTry, maybeFollowUp, size, list, _lib: lib, _replies: repliesSince };
