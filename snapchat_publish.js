"use strict";
/**
 * snapchat_publish.js — Ariana posts to her Snapchat Story and to Spotlight through the BulkPublish API
 * (https://github.com/azeemkafridi/bulkpublish-api), a hosted service that publishes to Snapchat with Snap's
 * own OAuth. Unlike the chat sidecar this is a supported route, no unofficial login involved.
 *
 * One-time setup (cannot be done from code): create a BulkPublish account, connect the Snapchat Public Profile
 * under Channels, create an API key under Settings > Developer. Then set BULKPUBLISH_API_KEY on Render.
 *
 *   story     exactly 1 image (jpg/png) or video (mp4/mov, vertical, 5-60 s). Snapchat carries no caption.
 *   spotlight exactly 1 vertical video, 6-60 s; the caption becomes the description (max 160 chars)
 *
 * Optional auto-posting of her stories: SNAPCHAT_STORY_POSTS=on  (1-2 a day, from her media library).
 */
const fs = require("fs");
const path = require("path");
const { planDay, nyDate } = require("./status_poster");

const IMAGE_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const VIDEO_EXT = { ".mp4": "video/mp4", ".mov": "video/quicktime" };
const MAX_BYTES = 200 * 1024 * 1024; // what we are willing to pull into memory (Snapchat allows 1 GB)
const FILE = path.join(process.env.STATE_SYNC_ROOT || __dirname, "snap_story_posts.json");

const extOf = (name) => path.extname(String(name || "").split("?")[0]).toLowerCase();

function createPublisher(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.BULKPUBLISH_API_KEY ?? "";
  const baseUrl = (opts.baseUrl || process.env.BULKPUBLISH_BASE_URL || "https://app.bulkpublish.com").replace(/\/$/, "");
  const doFetch = opts.fetch || fetch;
  let channelId = opts.channelId ?? (Number(process.env.BULKPUBLISH_SNAPCHAT_CHANNEL_ID) || null);

  const isConfigured = () => !!apiKey;

  async function api(method, p, { json, form } = {}) {
    if (!apiKey) throw new Error("BulkPublish is not configured (set BULKPUBLISH_API_KEY)");
    const headers = { Authorization: `Bearer ${apiKey}` };
    let body;
    if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    if (form) body = form;
    const r = await doFetch(baseUrl + p, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs || 120000) });
    const text = await r.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
    if (!r.ok) {
      const e = new Error(`BulkPublish ${r.status}: ${data?.error?.message || data?.error || data?.message || "request failed"}${data?.error?.code ? ` (${data.error.code})` : ""}`);
      e.status = r.status; e.code = data?.error?.code;
      throw e;
    }
    return data;
  }

  /** The connected Snapchat channel. Throws a plain-language error if there is none or its login expired. */
  async function snapchatChannel() {
    if (channelId) return channelId;
    const { channels = [] } = await api("GET", "/api/channels");
    const snaps = channels.filter((c) => String(c.platform).toLowerCase() === "snapchat");
    if (!snaps.length) throw new Error("No Snapchat channel is connected in BulkPublish. Connect it under Channels first.");
    const ok = snaps.find((c) => !c.tokenStatus || c.tokenStatus === "valid" || c.tokenStatus === "expiring_soon") || snaps[0];
    if (ok.tokenStatus === "expired") throw new Error("The Snapchat connection in BulkPublish has expired. Reconnect it under Channels.");
    channelId = ok.id;
    return channelId;
  }

  async function download(url) {
    const r = await doFetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`could not download media (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error("downloaded media is empty");
    if (buf.length > MAX_BYTES) throw new Error("media is too large");
    return buf;
  }

  async function upload(buffer, filename, mime) {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), filename);
    const d = await api("POST", "/api/media", { form });
    const id = d?.file?.id ?? d?.id;
    if (id == null) throw new Error("BulkPublish did not return a media id");
    return id;
  }

  /** type: "story" | "saved_story" | "spotlight". Returns { postId, type }. */
  async function publish({ type, url, caption, title }) {
    if (!["story", "saved_story", "spotlight"].includes(type)) throw new Error("type must be story, saved_story or spotlight");
    if (!/^https:\/\//i.test(String(url || ""))) throw new Error("media url must be https");
    const ext = extOf(url);
    const mime = IMAGE_EXT[ext] || VIDEO_EXT[ext];
    if (!mime) throw new Error("Snapchat takes jpg, png, mp4 or mov only");
    if (type === "spotlight" && !VIDEO_EXT[ext]) throw new Error("Spotlight needs a vertical video (mp4 or mov, 6-60 seconds)");
    const cid = await snapchatChannel();
    const mediaId = await upload(await download(url), path.basename(url.split("?")[0]) || `media${ext}`, mime);

    const snapOpts = {};
    if (type === "spotlight") snapOpts.saveToProfile = true;
    if (type === "saved_story" && title) snapOpts.title = String(title).slice(0, 45);
    const text = type === "story" ? "" : String(caption || "").slice(0, type === "spotlight" ? 160 : 400);
    const created = await api("POST", "/api/posts", {
      json: {
        content: text,
        channels: [{ channelId: cid }],
        mediaFiles: [mediaId],
        status: "draft",
        postFormat: VIDEO_EXT[ext] ? "video" : "post",
        postTypeOverrides: { snapchat: type },
        platformSpecific: { snapchat: { [String(cid)]: snapOpts } },
      },
    });
    const postId = created?.post?.id ?? created?.id;
    if (postId == null) throw new Error("BulkPublish did not return a post id");
    await api("POST", `/api/posts/${postId}/publish`, { json: {} });
    return { postId, type };
  }

  return { isConfigured, publish, snapchatChannel, postStory: (url) => publish({ type: "story", url }), postSpotlight: (url, caption) => publish({ type: "spotlight", url, caption }) };
}

/**
 * Her own story schedule: 1-2 pictures a day at random times in her waking hours, never repeating a recent picture.
 * deps: { enabled(), pickMedia(recentIds) -> {id,url}|null, post(url) -> Promise, now(), rand() }
 */
function createStoryPoster(deps) {
  const now = deps.now || (() => Date.now());
  const rand = deps.rand || Math.random;
  const file = deps.file || FILE;
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { day: "", slots: [], recent: [] }; } };
  const save = (s) => { try { fs.writeFileSync(file, JSON.stringify(s, null, 2)); } catch (e) { console.warn("[snap-story] could not save plan:", e.message); } };
  let st = load();

  async function tick() {
    if (!deps.enabled()) return false;
    const t = now();
    const today = nyDate(t);
    if (st.day !== today) { st = { day: today, slots: planDay(t, rand), recent: st.recent || [] }; save(st); console.log(`[snap-story] today's plan: ${st.slots.length} post(s)`); }
    const due = st.slots.find((s) => !s.done && s.at <= t);
    if (!due) return false;
    due.done = true; save(st); // mark first: never double-post if something throws
    try {
      const media = await deps.pickMedia(st.recent || []);
      if (!media) { console.warn("[snap-story] no picture to post"); return false; }
      await deps.post(media.url);
      st.recent = [...(st.recent || []), media.id].slice(-20); save(st);
      console.log("[snap-story] posted a story");
      return true;
    } catch (e) { console.warn("[snap-story] post failed:", e.message); return false; }
  }
  return { tick, get state() { return st; } };
}

module.exports = { createPublisher, createStoryPoster };
