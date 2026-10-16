"use strict";
/**
 * funny_media.js — find a funny GIF (as a short MP4) for her WhatsApp status, through GIPHY's public API
 * (GET /v1/gifs/search with rating filter; each result has images.<rendition>.mp4).
 * Needs GIPHY_API_KEY (free key from developers.giphy.com). Production use needs GIPHY's approval of the key.
 * Internet finds only ever go to the WhatsApp status (post_policy.js), never to Telegram / Snapchat / Instagram.
 */
const axios = require("axios");

const QUERIES = ["funny reaction", "funny cat", "funny dog", "funny fail", "hilarious", "wholesome funny", "funny dance", "laughing"];
const BLOCK = /\b(death|dead|dies|died|funeral|kill|murder|shoot|gun|war|bomb|terror|abuse|rape|suicide|nsfw|sex|nude|naked|porn|trump|biden|election|vote|politic|racis|nazi|church|mosque|bible|quran|religio)\w*/i;
const RENDITIONS = ["downsized_small", "fixed_height", "fixed_width", "original"]; // small first: status videos are tiny anyway

const pickMp4 = (images) => { for (const r of RENDITIONS) { const u = images && images[r] && images[r].mp4; if (u && /^https:\/\//i.test(u)) return u; } return null; };

/** -> { id, title, url, rating } | null. Skips anything above PG, anything with a sensitive title, and ids she used recently. */
async function findFunnyGif({ apiKey = process.env.GIPHY_API_KEY, http = axios, rand = Math.random, recentIds = [], base = process.env.GIPHY_BASE || "https://api.giphy.com" } = {}) {
  if (!apiKey) return null;
  const q = QUERIES[Math.floor(rand() * QUERIES.length)];
  const r = await http.get(`${base}/v1/gifs/search`, { params: { api_key: apiKey, q, limit: 25, offset: Math.floor(rand() * 25), rating: "pg", lang: "en" }, timeout: 15000 });
  const list = (r.data && r.data.data) || [];
  const ok = list.filter((g) => g && g.id && !recentIds.includes(g.id) && /^(y|g|pg)$/i.test(String(g.rating || "")) && !BLOCK.test(String(g.title || "")) && pickMp4(g.images));
  if (!ok.length) return null;
  const g = ok[Math.floor(rand() * ok.length)];
  return { id: g.id, title: String(g.title || "").replace(/\s*GIF( by .*)?$/i, "").trim(), url: pickMp4(g.images), rating: g.rating };
}

module.exports = { findFunnyGif, QUERIES };
