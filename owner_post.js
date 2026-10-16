"use strict";
/**
 * owner_post.js — "post it to your status", "post a gym pic on your story", "put that on your instagram",
 * "post a funny gif on your status": understands the OWNER'S natural-language request to post something,
 * and says plainly afterwards what went where. Pure parsing + wording; index.js supplies the media and senders.
 */
const ml = require("./media_library");

const VERB = "(?:post|put|upload|share|add|publish)";
const DEST_WORDS = /\b(status|statuses|story|stories|instagram|insta|ig|telegram|tg|snapchat|snap|spotlight|whatsapp)\b/i;

/** -> null (not a posting request) or { what, query, caption, only, explicit } */
function parse(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 400) return null;
  const m = t.match(new RegExp(`\\b${VERB}\\b[^.?!\\n]{0,70}?\\b(?:to|on|onto|in|at)\\s+(?:your|ur|ya|her|the)\\s+(?:[a-z]+\\s+){0,2}?(status|stories|story|instagram|insta|ig|telegram|tg|snapchat|snap|spotlight)\\b`, "i"))
    || t.match(new RegExp(`\\b${VERB}\\b[^.?!\\n]{0,30}\\b(?:to|on|onto|in)\\s+(?:your\\s+)?(?:whatsapp\\s+)?(status|stories|story)\\b`, "i"));
  if (!m) return null;
  const lower = t.toLowerCase();

  // where
  const only = [];
  const named = (re) => re.test(lower);
  if (named(/\bstatus(es)?\b/) || named(/\bwhatsapp\b/)) only.push("whatsapp_status");
  if (named(/\b(telegram|tg)\b/)) only.push("telegram_story");
  if (named(/\b(instagram|insta|ig)\b/)) only.push("instagram_post");
  if (named(/\bspotlight\b/)) only.push("snapchat_spotlight");
  if (named(/\b(snapchat|snap)\b/) && !only.includes("snapchat_spotlight")) only.push("snapchat_story");
  if (named(/\bstor(y|ies)\b/) && !only.some((d) => d === "telegram_story" || d === "snapchat_story" || d === "snapchat_spotlight")) only.push("telegram_story", "snapchat_story");
  if (!only.length) only.push("whatsapp_status");

  // what
  let what = "photo", query = "";
  if (/\b(funny|meme|gif|joke|hilarious|lol)\b/.test(lower)) what = "funny";
  else if (/\b(video|clip|vid|reel)\b/.test(lower)) what = "video";
  else if (/\b(it|that|this|those|them)\b/.test(lower.replace(/\b(to|on|in) (your|ur)\b/g, "")) && !/\b(a|an|any)\s+(?:[a-z]+\s+){0,2}(pic|photo|picture|selfie)\b/.test(lower)) what = "last";
  else if (/\b(the|that)\s+(pic|photo|picture|selfie|image)\s+(you|u)\s+(just|sent)/.test(lower)) what = "last";
  else query = lower.replace(new RegExp(`\\b${VERB}\\b|\\b(to|on|onto|in|at)\\b|\\b(your|ur|ya|her|the|a|an|one|some|new)\\b|\\b(status|statuses|story|stories|instagram|insta|ig|telegram|tg|snapchat|snap|spotlight|whatsapp)\\b|\\b(pic|pics|photo|photos|picture|pictures|selfie|selfies|image|please|pls|now)\\b`, "g"), " ").replace(/\s+/g, " ").trim();

  const cap = t.match(/\b(?:saying|caption(?:ed)?(?:\s+it)?|with the caption|with caption)\s*[:\-]?\s*["\u201c']?(.{1,160}?)["\u201d']?\s*$/i);
  return { what, query, caption: cap ? cap[1].trim() : "", only, explicit: DEST_WORDS.test(t) };
}

const LABEL = { whatsapp_status: "my WhatsApp status", telegram_story: "my Telegram story", instagram_post: "Instagram", snapchat_story: "my Snapchat story", snapchat_spotlight: "Snapchat Spotlight" };

/** Short, honest, first-person summary of what actually happened. */
function summarize(results, { what = "photo" } = {}) {
  const ok = results.filter((r) => r.ok).map((r) => LABEL[r.dest]);
  const bad = results.filter((r) => !r.ok);
  const parts = [];
  if (ok.length) parts.push(`done, ${what === "funny" ? "posted the funny one" : "posted it"} to ${ok.join(" and ")}`);
  for (const b of bad) parts.push(`${LABEL[b.dest]}: ${b.skipped ? b.skipped.replace(/^not allowed: .*$/, "that kind of post is not allowed there") : b.error}`);
  return parts.length ? parts.join(". ") : "nothing was posted";
}

/** Pick the library picture that matches the owner's words (tags), else a random one. */
function pickPicture(rows, query) { return ml.pickBest(rows, query, {}); }

module.exports = { parse, summarize, pickPicture };
