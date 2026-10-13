"use strict";
/**
 * status_poster.js — Ariana posts her own WhatsApp Status (the 24h stories) now and then, in her voice.
 *  • 1–2 posts a day at random times in her waking hours (America/New_York, 10:00–21:00), never closer than 3 h apart
 *  • text is written by her brain from her persona, told what she posted recently so she doesn't repeat herself
 *  • the plan for the day is kept in status_posts.json (mirrored to Supabase by state_sync, so deploys don't reset it)
 * Turn off with WA_STATUS_POSTS=off.
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(process.env.STATE_SYNC_ROOT || __dirname, "status_posts.json");
const TZ = "America/New_York";
const WINDOW = { startHour: 10, endHour: 21 };
const MIN_GAP_MS = 3 * 3600 * 1000;

const nyDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });          // 2026-10-13
const nyHour = (ms) => Number(new Date(ms).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false })) % 24;

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { day: "", slots: [], recent: [] }; } }
function save(st) { try { fs.writeFileSync(FILE, JSON.stringify(st, null, 2)); } catch (e) { console.warn("[status] could not save plan:", e.message); } }

/** Pick today's posting times (all in the future, inside her waking window). */
function planDay(now, rand = Math.random) {
  const count = rand() < 0.55 ? 2 : 1;
  const startMs = now;
  // candidate minutes-of-day inside the window, counted from the start of today's window in NY time
  const hourNow = nyHour(now);
  const msIntoHour = now % 3600000; // good enough: timezone offsets here are whole hours for NY
  const windowStart = now - (hourNow - WINDOW.startHour) * 3600000 - msIntoHour;
  const windowEnd = windowStart + (WINDOW.endHour - WINDOW.startHour) * 3600000;
  const from = Math.max(startMs + 10 * 60000, windowStart);
  if (from >= windowEnd) return [];
  const picks = [];
  for (let tries = 0; tries < 40 && picks.length < count; tries++) {
    const t = Math.floor(from + rand() * (windowEnd - from));
    if (picks.every((p) => Math.abs(p - t) >= MIN_GAP_MS)) picks.push(t);
  }
  return picks.sort((a, b) => a - b).map((at) => ({ at, done: false }));
}

function clean(text) {
  let t = String(text || "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/\s+/g, " ");
  t = t.replace(/\s*(?:\u2014|\u2013|--+)\s*/g, ", ");
  if (!t || t.length > 180) return null;
  if (/\bas an ai\b|\blanguage model\b|\bi am an ai\b/i.test(t)) return null;
  return t;
}

/**
 * deps: { generate(prompt) -> text|null, post(text) -> Promise, isConnected() -> Promise<bool>,
 *         now() -> ms, rand() -> 0..1, enabled() -> bool }
 * Returns { tick, postNow, state } — tick() is called every few minutes.
 */
function create(deps) {
  const now = deps.now || (() => Date.now());
  const rand = deps.rand || Math.random;
  let st = load();

  async function writeOne(reason) {
    const recent = (st.recent || []).slice(-8);
    const when = new Date(now()).toLocaleString("en-US", { timeZone: TZ, weekday: "long", hour: "numeric", minute: "2-digit" });
    const prompt =
      `Write your next WhatsApp Status update (it is ${when} for you). One short line, 3 to 15 words, the way you really text: casual, lowercase is fine, ` +
      `a thought, a small moment from your day, a mood, a joke. No hashtags, no dashes, no quotation marks, no emojis unless it genuinely fits, ` +
      `never mention being an AI, don't ask your followers questions.` +
      (recent.length ? `\nYou already posted these recently, so say something different:\n- ${recent.join("\n- ")}` : "") +
      `\nReply with the status text only.`;
    const text = clean(await deps.generate(prompt));
    if (!text) { console.warn(`[status] nothing usable generated (${reason})`); return null; }
    await deps.post(text);
    st.recent = [...(st.recent || []), text].slice(-20);
    console.log(`[status] posted (${reason}): ${text}`);
    return text;
  }

  async function tick() {
    if (!deps.enabled()) return false;
    const t = now();
    const today = nyDate(t);
    if (st.day !== today) { st = { day: today, slots: planDay(t, rand), recent: st.recent || [] }; save(st); console.log(`[status] today's plan: ${st.slots.length} post(s)`); }
    const due = st.slots.find((s) => !s.done && s.at <= t);
    if (!due) return false;
    if (!(await deps.isConnected())) return false; // try again next tick
    due.done = true; save(st);                      // mark first: never double-post if something throws
    try { const text = await writeOne("scheduled"); if (text) save(st); return !!text; }
    catch (e) { console.warn("[status] post failed:", e.message); return false; }
  }

  async function postNow(text) {
    const body = text ? clean(text) : await (async () => { return writeOne("manual"); })();
    if (text) { if (!body) throw new Error("that text can't be posted"); await deps.post(body); st.recent = [...(st.recent || []), body].slice(-20); console.log(`[status] posted (manual): ${body}`); }
    save(st);
    return body;
  }

  return { tick, postNow, get state() { return st; } };
}

module.exports = { create, planDay, clean, nyDate, nyHour };
