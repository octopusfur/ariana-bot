"use strict";
// media_library.js — tags for the pictures in Ariana's media library, so she knows what she is sending.
// Tags live in the existing `ariana_media.tags` jsonb column (no schema change). Dashboard: tap a photo's
// tag button to edit them, or leave the box empty to have Luna look at the photo and tag it.
const openai = require("./llm_openai");

const MAX_TAGS = 12, MAX_LEN = 40;

/** "Gym, black set ,gym" | ["Gym"] -> ["gym","black set"] */
function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,\n;]/) : [];
  const out = [];
  for (const t of raw) {
    const s = String(t == null ? "" : t).toLowerCase().replace(/[^\p{L}\p{N}\s'&+-]/gu, "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const STOP = new Set(["send", "me", "a", "an", "the", "your", "ur", "pic", "pics", "photo", "photos", "picture", "pictures", "selfie", "selfies", "image", "of", "you", "show", "one", "please", "pls", "let", "see", "something", "can", "give", "i", "want", "to", "another", "more", "new", "yourself", "media", "got", "any", "share", "post", "it", "is", "in", "on", "with", "and", "for", "now"]);
const words = (text) => String(text || "").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 2 && !STOP.has(w));

const stem = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
/** Whole-phrase tag match scores 2, a shared whole word scores 1 ("set" must not match "sunset"). */
function scoreRow(row, text) {
  const tags = normalizeTags(row && row.tags);
  if (!tags.length) return 0;
  const q = ` ${String(text || "").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim()} `;
  const qw = new Set(words(text).map(stem));
  let s = 0;
  for (const t of tags) {
    if (q.includes(` ${t} `)) s += 2;
    else if (t.split(" ").map(stem).some((w) => qw.has(w))) s += 1;
  }
  return s;
}

/**
 * Choose the picture to send: best tag match for what was asked; otherwise a random one she did not
 * send this person recently. Returns a row or null.
 */
function pickBest(rows, text, { recentIds = [], rand = Math.random } = {}) {
  const pool = (rows || []).filter((r) => r && r.url);
  if (!pool.length) return null;
  const scored = pool.map((r) => ({ r, s: scoreRow(r, text) }));
  const top = Math.max(...scored.map((x) => x.s));
  let cands = top > 0 ? scored.filter((x) => x.s === top).map((x) => x.r) : pool;
  const fresh = cands.filter((r) => !recentIds.includes(r.id));
  if (fresh.length) cands = fresh;
  return cands[Math.floor(rand() * cands.length)];
}

/** What she is told about the picture. Honest when a picture has no tags. */
function describe(row) {
  const tags = normalizeTags(row && row.tags);
  return tags.length ? `a photo of you tagged: ${tags.join(", ")}` : "a photo of you from your camera roll (it has not been tagged, so you do not know exactly what it shows; do not describe its contents)";
}

const recent = new Map();
const recentFor = (chat) => recent.get(chat) || [];
function rememberSent(chat, id) {
  if (!chat || !id) return;
  recent.set(chat, [...recentFor(chat).filter((x) => x !== id), id].slice(-5));
  if (recent.size > 2000) recent.delete(recent.keys().next().value);
}

/** Ask Luna to look at the photo and propose short tags. Returns [] on any failure (never throws). */
async function autoTag(url, { complete = openai.complete, apiKey = process.env.OPENAI_API_KEY } = {}) {
  if (!apiKey || !url) return [];
  try {
    const msg = await complete({
      apiKey, effort: "low", maxOutputTokens: 200, temperature: 0.2, models: ["gpt-6-luna"],
      sys: 'You tag photos for a personal media library. Look at the photo and reply with JSON only: {"tags":["..."]}. 4 to 8 short lowercase tags (1-3 words each) covering setting, clothing/colours, pose or activity, and vibe. Describe only what is visible; do not name people.',
      history: [{ role: "user", content: [{ type: "text", text: "Tag this photo." }, { type: "image_url", image_url: { url } }] }],
    });
    const m = String((msg && msg.content) || "").match(/\{[\s\S]*\}/);
    return m ? normalizeTags(JSON.parse(m[0]).tags) : [];
  } catch (e) { console.warn("[media] auto-tag failed:", e.message); return []; }
}

module.exports = { normalizeTags, scoreRow, pickBest, describe, recentFor, rememberSent, autoTag };
