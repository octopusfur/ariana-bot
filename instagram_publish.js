"use strict";
/**
 * instagram_publish.js — post ONE of her own pictures to her Instagram feed through Meta's official
 * Instagram Graph API (content publishing). Images only. Works for Instagram Business / Creator accounts only.
 *
 *   1. POST {base}/{ig-user-id}/media          { image_url, caption }  -> { id: <container> }
 *   2. GET  {base}/{container}?fields=status_code                      (wait for FINISHED)
 *   3. POST {base}/{ig-user-id}/media_publish  { creation_id }         -> { id: <media id> }
 * image_url must be a PUBLIC JPEG that Meta's servers can download.
 *
 * Env: INSTAGRAM_USER_ID, INSTAGRAM_ACCESS_TOKEN (token with the publish permission for that account),
 *      INSTAGRAM_GRAPH_BASE (default https://graph.facebook.com/v24.0; https://graph.instagram.com/v24.0 for Instagram Login tokens)
 * The token is never logged or returned in an error.
 */
const axios = require("axios");

const cfg = (env = process.env) => ({
  userId: String(env.INSTAGRAM_USER_ID || "").trim(),
  token: String(env.INSTAGRAM_ACCESS_TOKEN || "").trim(),
  base: String(env.INSTAGRAM_GRAPH_BASE || "https://graph.facebook.com/v24.0").replace(/\/$/, ""),
});
const isConfigured = (env = process.env) => { const c = cfg(env); return !!(c.userId && c.token); };

const scrub = (msg, token) => String(msg || "").split(token || "\u0000").join("***").slice(0, 200);

async function publishPhoto({ imageUrl, caption = "" }, { env = process.env, http = axios, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const c = cfg(env);
  if (!c.userId || !c.token) throw new Error("Instagram is not set up (INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN)");
  if (!/^https:\/\//i.test(String(imageUrl || ""))) throw new Error("Instagram needs a public https image URL");
  const call = async (method, path, data) => {
    try {
      const r = await http({ method, url: `${c.base}/${path}`, ...(method === "get" ? { params: { ...data, access_token: c.token } } : { data: { ...data, access_token: c.token } }), timeout: 30000, validateStatus: () => true });
      if (r.status >= 400 || (r.data && r.data.error)) throw new Error((r.data && r.data.error && r.data.error.message) || `HTTP ${r.status}`);
      return r.data || {};
    } catch (e) { throw new Error(`Instagram: ${scrub(e.message, c.token)}`); }
  };
  const container = await call("post", `${c.userId}/media`, { image_url: imageUrl, caption: String(caption || "").slice(0, 2200) });
  if (!container.id) throw new Error("Instagram: no container id returned");
  for (let i = 0; i < 8; i++) { // images are normally ready at once; wait briefly if not
    const st = await call("get", container.id, { fields: "status_code" });
    if (!st.status_code || st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`Instagram: container ${st.status_code}`);
    await sleep(1500);
  }
  const done = await call("post", `${c.userId}/media_publish`, { creation_id: container.id });
  return { id: done.id || null };
}

module.exports = { publishPhoto, isConfigured };
