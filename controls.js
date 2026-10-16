"use strict";
/**
 * controls.js -- the settings you change from the dashboard ("Her life" screen) instead of Render env vars.
 * Stored in controls.json (mirrored to Supabase by state_sync, so redeploys don't reset it). Every value is validated and
 * clamped on the way in, and anything missing falls back to a default (env vars from before still seed the first defaults).
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(process.env.STATE_SYNC_ROOT || __dirname, "controls.json");
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null && v !== undefined ? Number(v) : d);
const bool = (v, d) => (typeof v === "boolean" ? v : d);
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(num(v, d))));

function defaults(env = process.env) {
  return {
    status: {
      enabled: env.WA_STATUS_POSTS !== "off",
      postsMin: Math.min(6, Math.max(1, num(env.STATUS_POSTS_MIN, 2))),
      postsMax: Math.min(6, Math.max(1, num(env.STATUS_POSTS_MAX, 3))),
      kinds: { text: true, photo: true, found: true, video: true, gif: true },
      topics: { funny: true, news: true },
      telegramStory: env.TG_STORY_POSTS !== "off",
      instagram: env.IG_POSTS !== "off",
      snapchatStory: env.SNAP_STORY_MIRROR !== "off",
      snapchatSpotlight: env.SNAP_SPOTLIGHT !== "off",
    },
    photos: {
      enabled: true,
      cooldownMin: Math.max(0, num(env.PHOTO_COOLDOWN_MIN, 5)),
      dailyCap: Math.max(1, num(env.PHOTO_DAILY_CAP, 5)),
      sendToOthers: true,
      othersDailyCap: Math.max(1, num(env.PHOTO_OTHERS_DAILY_CAP, 6)),
    },
    memory: { autoApprove: String(env.MEMORY_AUTO_APPROVE || "on").toLowerCase() !== "off" },
    // she looks at other people's WhatsApp Status like a person: a few looks a day, skipping flooders and vendors
    watch: {
      enabled: env.WA_STATUS_WATCH !== "off",
      maxPerPoster: clamp(env.STATUS_WATCH_MAX_PER_POSTER, 3, 40, 10), // more than this in a day = flooder, skipped completely
      dailyPosters: clamp(env.STATUS_WATCH_DAILY_POSTERS, 1, 30, 8),   // people she opens per day
      maxItems: clamp(env.STATUS_WATCH_MAX_ITEMS, 1, 8, 4),            // items she watches from one person
      onlyKnown: true,                                                 // only people she already chats with
      skipVendors: true,                                               // business accounts, prices, "DM to order"...
      react: true, reactCap: 6,                                        // emoji reactions per day
      reply: true, replyCap: 3,                                        // short replies per day
    },
  };
}


/** Merge an untrusted patch (or stored file) over a base, keeping only known keys with valid, clamped values. */
function sanitize(input, base) {
  const i = input && typeof input === "object" ? input : {};
  const s = i.status || {}, p = i.photos || {}, m = i.memory || {}, w = i.watch || {};
  const out = {
    status: {
      enabled: bool(s.enabled, base.status.enabled),
      postsMin: clamp(s.postsMin, 1, 6, base.status.postsMin),
      postsMax: clamp(s.postsMax, 1, 6, base.status.postsMax),
      kinds: {
        text: bool(s.kinds && s.kinds.text, base.status.kinds.text),
        photo: bool(s.kinds && s.kinds.photo, base.status.kinds.photo),
        found: bool(s.kinds && s.kinds.found, base.status.kinds.found),
        video: bool(s.kinds && s.kinds.video, base.status.kinds.video),
        gif: bool(s.kinds && s.kinds.gif, base.status.kinds.gif),
      },
      topics: {
        funny: bool(s.topics && s.topics.funny, base.status.topics.funny),
        news: bool(s.topics && s.topics.news, base.status.topics.news),
      },
      telegramStory: bool(s.telegramStory, base.status.telegramStory),
      instagram: bool(s.instagram, base.status.instagram),
      snapchatStory: bool(s.snapchatStory, base.status.snapchatStory),
      snapchatSpotlight: bool(s.snapchatSpotlight, base.status.snapchatSpotlight),
    },
    photos: {
      enabled: bool(p.enabled, base.photos.enabled),
      cooldownMin: clamp(p.cooldownMin, 0, 240, base.photos.cooldownMin),
      dailyCap: clamp(p.dailyCap, 1, 50, base.photos.dailyCap),
      sendToOthers: bool(p.sendToOthers, base.photos.sendToOthers),
      othersDailyCap: clamp(p.othersDailyCap, 1, 50, base.photos.othersDailyCap),
    },
    memory: { autoApprove: bool(m.autoApprove, base.memory.autoApprove) },
    watch: {
      enabled: bool(w.enabled, base.watch.enabled),
      maxPerPoster: clamp(w.maxPerPoster, 3, 40, base.watch.maxPerPoster),
      dailyPosters: clamp(w.dailyPosters, 1, 30, base.watch.dailyPosters),
      maxItems: clamp(w.maxItems, 1, 8, base.watch.maxItems),
      onlyKnown: bool(w.onlyKnown, base.watch.onlyKnown),
      skipVendors: bool(w.skipVendors, base.watch.skipVendors),
      react: bool(w.react, base.watch.react),
      reactCap: clamp(w.reactCap, 0, 30, base.watch.reactCap),
      reply: bool(w.reply, base.watch.reply),
      replyCap: clamp(w.replyCap, 0, 20, base.watch.replyCap),
    },
  };
  if (out.status.postsMax < out.status.postsMin) out.status.postsMax = out.status.postsMin;
  // at least one kind and one topic must stay on, or the poster would have nothing to write
  if (!out.status.kinds.text && !out.status.kinds.photo && !out.status.kinds.found) out.status.kinds.text = true; // video / gif posts depend on what exists, so they do not count
  if (!out.status.topics.funny && !out.status.topics.news) out.status.topics.funny = true;
  return out;
}

function create({ file = FILE, env = process.env } = {}) {
  const base = defaults(env);
  let cur = base;
  try { cur = sanitize(JSON.parse(fs.readFileSync(file, "utf8")), base); } catch { /* first run: defaults */ }
  const get = () => cur;
  function update(patch) {
    cur = sanitize(mergeDeep(JSON.parse(JSON.stringify(cur)), patch), base);
    try { fs.writeFileSync(file, JSON.stringify(cur, null, 2)); } catch (e) { console.warn("[controls] could not save:", e.message); }
    return cur;
  }
  function reset() { cur = defaults(env); try { fs.writeFileSync(file, JSON.stringify(cur, null, 2)); } catch {} return cur; }
  return { get, update, reset, defaults: () => defaults(env) };
}

function mergeDeep(a, b) {
  if (!b || typeof b !== "object") return a;
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) a[k] = mergeDeep(a[k] && typeof a[k] === "object" ? a[k] : {}, b[k]);
    else a[k] = b[k];
  }
  return a;
}

module.exports = { create, defaults, sanitize, FILE };
