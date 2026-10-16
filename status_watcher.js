"use strict";
/**
 * status_watcher.js — Ariana looks at other people's WhatsApp Status like a person would, not like a bot.
 *
 *  • She does NOT watch everything. A few short "looks" a day at random times in her waking hours.
 *  • She skips people who flood: someone who dumps 30, 100, 200 pictures/videos at once is skipped completely.
 *  • She skips vendors and promoters: business accounts, prices, "DM to order", "available", phone numbers, and so on.
 *  • By default she only looks at people she already knows (someone she has chatted with).
 *  • Of the people left she opens only some, watches the first few items, and most of the time does nothing.
 *  • Only when something genuinely interests her does she react with an emoji or send a short reply,
 *    inside daily caps, never twice to the same person within 12 hours.
 *
 * Settings come from the dashboard ("Her life" -> Watching statuses). The plan/log is kept in status_watch.json
 * (mirrored to Supabase by state_sync, so deploys don't reset it).
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(process.env.STATE_SYNC_ROOT || __dirname, "status_watch.json");
const TZ = "America/New_York";
const AWAKE = { from: 9, to: 23 };           // her waking hours (Miami time)
const STATUS_LIFE_MS = 23 * 3600 * 1000;     // WhatsApp statuses last 24h
const COOLDOWN_SAME_PERSON_MS = 12 * 3600 * 1000;

const nyDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const nyHour = (ms) => Number(new Date(ms).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false })) % 24;

// ── what a vendor / promoter status looks like ────────────────
const VENDOR_WORDS = /(\bprice[sd]?\b|\bpricing\b|\bsale\b|\bon sale\b|\bdiscount\b|\bpromo(tion)?\b|\border(s|ing)?\b|\bpre-?order\b|\bdelivery\b|\bin stock\b|\brestock(ed)?\b|\bavailable\b|\bwholesale\b|\bretail\b|\bdm (me |us )?(to|for|now)\b|\bpay(ment)?\b|\bwhatsapp (me|us)\b|\bcontact (me|us)\b|\bcall (me|us)\b|\bshop\b|\bstore\b|\bbuy(ing)?\b|\bsell(ing)?\b|\bfor sale\b|\bnew arrivals?\b|\bnaira\b|\bcod\b|\blink in bio\b|\bclick (the )?link\b|\bjoin (my|our) (group|channel|community)\b|\bforex\b|\bcrypto\b|\binvest(ment|ing)?\b|\bloans?\b|\bgiveaway\b|\bvisit (us|our)\b|\bour (products?|services?|store|shop)\b|\bcustomers?\b|\bbook (now|an? appointment)\b|\bhiring\b|\bvacancy\b)/i;
const PRICE = /([$£€₦]\s?\d|\b\d[\d,.]*\s?(k|naira|ngn|usd|dollars)\b)/i;
const PHONE = /(\+?\d[\d\s().-]{8,}\d)/;
const STRONG_SALES = /(\bdm (me |us )?(to|for|now)\b|\bfor sale\b|\bpre-?order\b|\bwholesale\b|\bin stock\b|\brestock(ed)?\b|\bprice list\b|\border now\b)/i;

function captionsOf(items) { return (items || []).map((i) => String(i.caption || "").trim()).filter(Boolean); }

/** Is this poster selling / promoting? `known` = she has chatted with them (be more careful before calling a friend a vendor). */
function looksLikeVendor(items, info = {}, known = false) {
  if (info.isBusiness) return true;
  const caps = captionsOf(items);
  if (!caps.length) return false;
  let hits = 0, strong = 0;
  for (const c of caps) {
    const price = PRICE.test(c) || PHONE.test(c) || STRONG_SALES.test(c);
    if (price) strong++;
    if (price || VENDOR_WORDS.test(c)) hits++;
  }
  // a friend may say one shopping word; a few clear sales posts from anyone is a vendor
  if (known) return strong >= 2 || hits >= 3 || (caps.length >= 3 && hits / caps.length >= 0.6);
  return hits >= 2 || hits / caps.length >= 0.5;
}

/** Flooders: way too many items in the last 24h (or a big dump in a short window). */
function isFlood(items, cfg) {
  const n = (items || []).length;
  if (n > cfg.maxPerPoster) return true;
  const ts = (items || []).map((i) => i.ts).filter(Number.isFinite).sort((a, b) => a - b);
  for (let a = 0, b = 0; b < ts.length; b++) {          // sliding 30-minute window
    while (ts[b] - ts[a] > 30 * 60000) a++;
    if (b - a + 1 > Math.max(6, Math.ceil(cfg.maxPerPoster * 0.8))) return true;
  }
  return false;
}

/** → { skip: true, reason } or { skip: false } for one poster. */
function judgePoster(p, cfg, { known = false, info = {} } = {}) {
  if (cfg.onlyKnown && !known) return { skip: true, reason: "not someone she knows" };
  if (isFlood(p.items, cfg)) return { skip: true, reason: `posted ${p.items.length} in a day` };
  if (cfg.skipVendors && looksLikeVendor(p.items, info, known)) return { skip: true, reason: "looks like a vendor / promo" };
  return { skip: false };
}

function clean(text, max = 140) {
  let t = String(text || "").trim().replace(/^["'“”‘’]+|[“”"]+$/g, "").replace(/\s+/g, " ");
  t = t.replace(/\s*(?:\u2014|\u2013|--+)\s*/g, ", ");
  if (!t || t.length > max) return null;
  if (/\bas an ai\b|\blanguage model\b|\bi am an ai\b/i.test(t)) return null;
  return t;
}
const EMOJI = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*){1,2}$/u;

/** Pull her decisions out of the model's answer. Anything unusable simply means "no reaction". */
function parseDecisions(raw, count) {
  const out = [];
  let obj = null;
  try { const m = String(raw || "").match(/\{[\s\S]*\}/); obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
  const arr = obj && Array.isArray(obj.items) ? obj.items : [];
  for (const d of arr) {
    const n = Number(d && d.n);
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    const interest = Math.max(0, Math.min(10, Number(d.interest) || 0));
    let act = ["react", "reply"].includes(d.do) ? d.do : "none";
    const emoji = typeof d.emoji === "string" && EMOJI.test(d.emoji.trim()) ? d.emoji.trim() : null;
    const text = clean(d.text);
    if (act === "react" && !emoji) act = "none";
    if (act === "reply" && !text) act = "none";
    out.push({ n, interest, act, emoji, text });
  }
  return out;
}

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { day: "", nextAt: 0, today: { posters: 0, items: 0, reactions: 0, replies: 0, skipped: 0 }, seen: {}, last: {}, log: [] }; }
}
function save(st) { try { fs.writeFileSync(FILE, JSON.stringify(st, null, 2)); } catch (e) { console.warn("[watch] could not save:", e.message); } }

const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];
const shuffle = (arr, rand) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/**
 * deps: {
 *   cfg() -> controls.watch,           enabled() -> bool,           isConnected() -> Promise<bool>,
 *   snapshot() -> Promise<[{ jid, number, name, items:[{id,kind,caption,ts}] }]>,
 *   businessInfo(poster) -> Promise<{isBusiness}>,                  isKnown(number) -> bool,
 *   relation(number) -> string,        look(poster, item) -> Promise<string|null> (describes a picture),
 *   generate(prompt) -> Promise<string|null>,
 *   view(poster, ids), react(poster, id, emoji), reply(poster, id, text)  -> Promise,
 *   now(), rand(), sleep(ms)
 * }
 * Returns { tick, state } — tick() is called every few minutes.
 */
function create(deps) {
  const now = deps.now || (() => Date.now());
  const rand = deps.rand || Math.random;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const st = load();
  let running = false;

  const note = (kind, who, detail) => {
    st.log.push({ at: now(), kind, who, detail: String(detail || "").slice(0, 160) });
    if (st.log.length > 80) st.log.splice(0, st.log.length - 80);
  };
  const rollDay = () => {
    const d = nyDate(now());
    if (st.day !== d) { st.day = d; st.today = { posters: 0, items: 0, reactions: 0, replies: 0, skipped: 0 }; }
  };
  const markSeen = (id) => {
    st.seen[id] = now();
    const keys = Object.keys(st.seen);
    if (keys.length > 800) for (const k of keys.sort((a, b) => st.seen[a] - st.seen[b]).slice(0, keys.length - 600)) delete st.seen[k];
  };
  const scheduleNext = () => { st.nextAt = now() + (25 + Math.floor(rand() * 95)) * 60000; };

  async function decide(poster, viewed, relation) {
    const lines = [];
    for (let i = 0; i < viewed.length; i++) {
      const it = viewed[i];
      let seen = "";
      if (it.kind === "image" && deps.look) { try { const d = await deps.look(poster, it); if (d) seen = ` — what the picture shows: ${d}`; } catch { /* captions only */ } }
      lines.push(`${i + 1}. ${it.kind}${it.caption ? ` with caption “${String(it.caption).slice(0, 200)}”` : " (no caption)"}${seen}`);
    }
    const prompt =
      `You are Ariana, scrolling through WhatsApp Status on your phone like any normal person. ${poster.name || "Someone"} posted these (${relation}):\n${lines.join("\n")}\n\n` +
      `Be a real human about it: most statuses are boring and you just scroll past them without reacting. Only something that actually catches you gets a reaction or a reply: ` +
      `it's funny, sweet, good news, a pretty view, something about food or a trip you'd talk about, something you'd honestly want to say something about. ` +
      `Never react to sad, angry or sensitive posts in a cheesy way, never to ads, and don't be overeager.\n` +
      `Answer with ONLY this JSON, one entry per item above:\n` +
      `{"items":[{"n":1,"interest":0-10,"do":"none"|"react"|"reply","emoji":"one emoji if reacting","text":"your short reply in your own voice if replying (under 120 characters, no hashtags, no dashes)"}]}\n` +
      `Use "do":"none" unless interest is 7 or higher. A reply is rarer than a reaction.`;
    const raw = await deps.generate(prompt);
    return parseDecisions(raw, viewed.length);
  }

  /** One "look at statuses" session. Returns a short report (also used by tests). */
  async function session() {
    const cfg = deps.cfg();
    const report = { viewed: 0, reacted: 0, replied: 0, skipped: 0, note: "" };
    let snap = [];
    try { snap = (await deps.snapshot()) || []; } catch (e) { console.warn("[watch] could not read statuses:", e.message); report.note = "could not read statuses from WhatsApp: " + e.message; return report; }
    if (!snap.length) { report.note = "no statuses have arrived on her WhatsApp yet"; return report; }

    // 1) throw away what's too old / already dealt with, then decide who is even worth opening
    const fresh = [];
    for (const p of snap) {
      const items = (p.items || []).filter((i) => i && i.id && now() - (i.ts || now()) < STATUS_LIFE_MS);
      const unseen = items.filter((i) => !st.seen[i.id]);
      if (!unseen.length) continue;
      fresh.push({ ...p, items, unseen });
    }
    if (!fresh.length) { report.note = "nothing new since the last look"; return report; }
    const eligible = [];
    for (const p of fresh) {
      let info = {};
      if (cfg.skipVendors && deps.businessInfo) { try { info = (await deps.businessInfo(p)) || {}; } catch { info = {}; } }
      const v = judgePoster(p, cfg, { known: deps.isKnown ? deps.isKnown(p.number) : false, info });
      if (v.skip) {
        for (const i of p.items) markSeen(i.id);          // never reconsidered
        report.skipped++; st.today.skipped++;
        note("skipped", p.name || p.number, v.reason);
      } else eligible.push(p);
    }
    if (!eligible.length) { report.note = `${report.skipped} skipped (flooders, vendors, or people she doesn't know), none left to watch`; return report; }

    // 2) like a person: only some of them, only a few at a time, within the daily limit
    const room = Math.max(0, cfg.dailyPosters - st.today.posters);
    const howMany = Math.min(room, 1 + Math.floor(rand() * 3));
    if (!room) { report.note = "daily limit of people reached"; return report; }
    const chosen = shuffle(eligible, rand).filter(() => rand() < 0.65).slice(0, howMany);
    if (!chosen.length) report.note = "she scrolled past everyone this time";
    for (const p of chosen) {
      const first = p.unseen.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const take = Math.max(1, Math.min(cfg.maxItems, 1 + Math.floor(rand() * cfg.maxItems)));
      const viewed = first.slice(0, take);
      const relation = deps.relation ? deps.relation(p.number) : "someone you know";
      let decisions = [];
      try { decisions = await decide(p, viewed, relation); } catch (e) { console.warn("[watch] could not decide:", e.message); }

      try { await deps.view(p, viewed.map((i) => i.id)); } catch (e) { console.warn("[watch] view failed:", e.message); }
      for (const i of viewed) markSeen(i.id);
      for (const i of p.items) if (!viewed.includes(i) && !st.seen[i.id] && rand() < 0.5) markSeen(i.id); // the ones she scrolled past
      st.today.posters++; st.today.items += viewed.length; report.viewed += viewed.length;
      note("viewed", p.name || p.number, `${viewed.length} of ${p.items.length}`);
      await sleep(2000 + Math.floor(rand() * 7000));

      // 3) maybe react / reply, rarely, never twice to the same person in 12h
      const recentlyDone = st.last[p.number] && now() - st.last[p.number] < COOLDOWN_SAME_PERSON_MS;
      if (recentlyDone) continue;
      const best = decisions.filter((d) => d.interest >= 7 && d.act !== "none").sort((a, b) => b.interest - a.interest)[0];
      if (!best) continue;
      const item = viewed[best.n - 1];
      if (best.act === "react" && cfg.react && st.today.reactions < cfg.reactCap && rand() < 0.7) {
        await sleep(4000 + Math.floor(rand() * 30000));
        try { await deps.react(p, item.id, best.emoji); st.today.reactions++; st.last[p.number] = now(); report.reacted++; note("reacted", p.name || p.number, best.emoji); }
        catch (e) { console.warn("[watch] react failed:", e.message); }
      } else if (best.act === "reply" && cfg.reply && st.today.replies < cfg.replyCap && rand() < 0.6) {
        await sleep(15000 + Math.floor(rand() * 90000));
        try { await deps.reply(p, item.id, best.text); st.today.replies++; st.last[p.number] = now(); report.replied++; note("replied", p.name || p.number, best.text); }
        catch (e) { console.warn("[watch] reply failed:", e.message); }
      }
    }
    return report;
  }

  const why = (result) => { st.lastTick = { at: now(), result }; };

  async function tick() {
    if (running) return false;
    running = true;
    try {
      if (!deps.enabled()) { why("switched off, or the WhatsApp status engine isn't running on this server"); return false; }
      rollDay();
      const h = nyHour(now());
      if (h < AWAKE.from || h >= AWAKE.to) { why("night time, she isn't looking at her phone"); return false; }
      if (!st.nextAt) { scheduleNext(); save(st); why("just started, waiting before her first look"); return false; }   // first run: wait a while before the first look
      if (now() < st.nextAt) { why("waiting for her next look"); return false; }
      if (!(await deps.isConnected())) { why("WhatsApp isn't connected"); return false; }
      const rep = await session();
      scheduleNext();
      why(rep.note || (rep.viewed ? `watched ${rep.viewed} item(s)` : "looked, nothing to watch"));
      save(st);
      return rep.viewed > 0 || rep.skipped > 0;
    } catch (e) { why("error: " + e.message); console.warn("[watch] tick failed:", e.message); return false; }
    finally { running = false; }
  }

  /** "Look now" from the dashboard: ignores the schedule and night hours (still needs WhatsApp connected). */
  async function lookNow() {
    if (running) return { note: "she is already looking" };
    running = true;
    try {
      if (!deps.enabled()) return { note: "switched off, or the WhatsApp status engine isn't running on this server" };
      if (!(await deps.isConnected())) return { note: "WhatsApp isn't connected" };
      rollDay();
      const rep = await session();
      scheduleNext(); why("manual look: " + (rep.note || (rep.viewed ? `watched ${rep.viewed} item(s)` : "nothing to watch")));
      save(st);
      return rep;
    } finally { running = false; }
  }

  return { tick, session, lookNow, state: st };
}

module.exports = { create, judgePoster, looksLikeVendor, isFlood, parseDecisions, nyHour, FILE };
