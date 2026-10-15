"use strict";
/**
 * photo_skill.js — Ariana's own pictures (the dashboard media library) that she can send ONLY if she chooses to.
 *
 * She is handed a `send_photo` tool on turns where someone asks to see her, plus the list of her pictures (id + the tags
 * you gave them in the dashboard). Whether she sends one, which one, or says no / teases / makes them wait is her call.
 * The tool only queues the photo; index.js delivers it together with her message.
 *
 * Guards (so one person can't drain the library): PHOTO_COOLDOWN_MIN (default 5) between pictures to the same chat,
 * PHOTO_DAILY_CAP (default 5) per chat per 24h. Videos are never offered.
 */
const ASK_RE = /\b(pics?|pictures?|photos?|selfies?|snaps?|see (you|u|her|ur face|your face)|show (me )?(you|yourself|u|your face|ur face)|(what|how) (do )?(you|u) look|your face|ur face|face reveal|let me see)\b/i;

/** True when this message is someone asking to see her (not them sharing their own photo, which arrives as "[sent a photo]"). */
function looksLikePhotoRequest(text) {
  const t = String(text || "").trim();
  return !!t && !t.startsWith("[") && ASK_RE.test(t);
}

function tagsOf(row) {
  let t = row && row.tags;
  if (typeof t === "string") { try { t = JSON.parse(t); } catch { t = t.split(","); } }
  return (Array.isArray(t) ? t : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
}

function createPhotoSkill({ fetchRows, resolveTarget = null, deliver = null, now = Date.now, env = process.env }) {
  const CACHE_MS = 60 * 1000, MAX_LIST = 40, PENDING_MS = 2 * 60 * 1000;
  const cooldownMs = Math.max(0, Number(env.PHOTO_COOLDOWN_MIN ?? 5)) * 60 * 1000;
  const dailyCap = Math.max(1, Number(env.PHOTO_DAILY_CAP ?? 5));
  const othersDailyCap = Math.max(1, Number(env.PHOTO_OTHERS_DAILY_CAP ?? 6)); // pictures she sends to people other than the one she is chatting with
  const sentToOthers = [];
  let cache = { at: 0, items: [] };
  const pending = new Map(); // convoId -> { url, caption, at }
  const sent = new Map();    // convoId -> [timestamps]

  async function snapshot() {
    if (cache.at && now() - cache.at < CACHE_MS) return cache.items;
    try {
      const rows = (await fetchRows()) || [];
      const seen = new Set(), items = [];
      for (const r of rows) {
        if (!r || !r.url || !r.id) continue;
        if (String(r.media_type || "").toLowerCase() === "video" || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(r.url)) continue;
        const id = String(r.id).replace(/-/g, "").slice(0, 6);
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, url: r.url, tags: tagsOf(r) });
        if (items.length >= MAX_LIST) break;
      }
      cache = { at: now(), items };
    } catch (e) {
      console.warn("[photos] library fetch failed:", e.message);
      cache = { at: now(), items: cache.items }; // keep the last good list, retry after the cache window
    }
    return cache.items;
  }

  function schema(items) {
    return {
      type: "function",
      function: {
        name: "send_photo",
        description: "Send ONE of your own pictures to the person you are chatting with. Only use this if YOU decide to. Nobody is owed a picture: you can say no, tease, or make them wait instead.",
        parameters: {
          type: "object",
          properties: {
            photo_id: { type: "string", enum: items.map((i) => i.id), description: "id of the picture from your library" },
            caption: { type: "string", description: "optional short caption, in your own voice" },
            ...(resolveTarget && deliver ? { to: { type: "string", description: "optional: the name or number of SOMEONE ELSE you already know, if you want to send it to them instead. Leave out to send it to the person you are chatting with." } } : {}),
          },
          required: ["photo_id"],
        },
      },
    };
  }

  function promptNote(items) {
    const list = items.map((i) => `- ${i.id}: ${i.tags.length ? i.tags.join(", ") : "untagged"}`).join("\n");
    return `YOUR PHOTOS: You keep a private library of your own pictures, and this person is asking to see you. Whether you send one is entirely YOUR choice. Stay yourself: you can say no, tease, make them wait or earn it, or send one if you feel like it. To send one, call send_photo with the id you want, then write your message as if you just sent it (short, don't describe the picture). Never claim you sent a picture without calling send_photo, and don't send more than one unless you really want to. You only know a picture by its tags below.\nIf you want to, you can also send one to someone else you already know by passing their name or number in "to" (never to a stranger).\nLibrary (id: tags):\n${list}`;
  }

  /** She chose to send a picture to someone else she already knows: goes out right away. Strangers are refused. */
  async function sendElsewhere(convoId, item, toRaw, caption) {
    if (!resolveTarget || !deliver) return null;
    const target = await resolveTarget(toRaw, convoId);
    if (!target) return { ok: false, note: `[You don't know anyone called "${toRaw}", so nothing was sent. You only send pictures to people you already talk to.]` };
    if (target.id === convoId) return null; // that is just the current chat
    const t = now();
    const recent = (sent.get(target.id) || []).filter((x) => t - x < 24 * 60 * 60 * 1000);
    sent.set(target.id, recent);
    while (sentToOthers.length && t - sentToOthers[0] > 24 * 60 * 60 * 1000) sentToOthers.shift();
    if (recent.length && t - recent[recent.length - 1] < cooldownMs) return { ok: false, note: `[You already sent ${target.name} a picture a moment ago. Nothing sent.]` };
    if (recent.length >= dailyCap) return { ok: false, note: `[You've already sent ${target.name} plenty of pictures today. Nothing sent.]` };
    if (sentToOthers.length >= othersDailyCap) return { ok: false, note: "[You've already sent enough pictures to other people today. Nothing sent.]" };
    try { await deliver(target.id, item.url, caption); }
    catch (e) { console.warn(`[photos] could not send to ${target.name}: ${e.message}`); return { ok: false, note: `[It didn't go through to ${target.name} (${e.message}). Nothing was sent.]` }; }
    recent.push(t); sentToOthers.push(t);
    console.log(`[photos] she chose to send ${item.id} to ${target.name}`);
    return { ok: true, note: `[Done: that picture was sent to ${target.name}. Now write your reply as normal.]` };
  }

  async function execute(convoId, args) {
    const items = await snapshot();
    const item = items.find((i) => i.id === String((args && args.photo_id) || ""));
    if (!item) return { ok: false, note: "[That picture isn't in your library. Pick an id from your list, or just don't send one.]" };
    const toRaw = String((args && args.to) || "").trim();
    if (toRaw) { const r = await sendElsewhere(convoId, item, toRaw, String((args && args.caption) || "").trim().slice(0, 140)); if (r) return r; }
    const t = now();
    const recent = (sent.get(convoId) || []).filter((x) => t - x < 24 * 60 * 60 * 1000);
    sent.set(convoId, recent);
    if (pending.has(convoId) && t - pending.get(convoId).at < PENDING_MS) return { ok: false, note: "[A picture is already on its way with this message. Just write your message.]" };
    if (recent.length && t - recent[recent.length - 1] < cooldownMs) return { ok: false, note: `[You sent them a picture ${Math.max(1, Math.round((t - recent[recent.length - 1]) / 60000))} min ago. Nothing sent. Make them wait, in your own way.]` };
    if (recent.length >= dailyCap) return { ok: false, note: "[You've already sent them plenty of pictures today. Nothing sent. Tell them in your own way that's enough for today.]" };
    pending.set(convoId, { url: item.url, caption: String((args && args.caption) || "").trim().slice(0, 140), at: t });
    recent.push(t);
    return { ok: true, note: "[Done: that picture will arrive together with your next message. Now write your message as if you just sent it.]" };
  }

  /** The picture she queued for this chat (once), or null. */
  function take(convoId) {
    const p = pending.get(convoId);
    pending.delete(convoId);
    return p && now() - p.at < PENDING_MS ? p : null;
  }

  return { snapshot, schema, promptNote, execute, take, canSendToOthers: () => !!(resolveTarget && deliver) };
}

module.exports = { createPhotoSkill, looksLikePhotoRequest };
