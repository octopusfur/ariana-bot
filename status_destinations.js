"use strict";
/**
 * status_destinations.js — the real senders behind post_policy.js (WhatsApp status, Telegram story, Snapchat story + Spotlight, Instagram).
 * Each sender takes ONE item: { source, type, payload, url } where payload = { text, base64, mimetype, video? } and url = her library URL.
 * Anything that cannot work (not set up, wrong shape) returns null / throws a plain-language reason; nothing is faked.
 */
const IMG_EXT = /\.(jpe?g|png)(\?|$)/i, VID_EXT = /\.(mp4|mov)(\?|$)/i;

function create(deps) {
  const {
    waWeb, getTgClient, telegramStory, instagram, hostPublicJpeg, snapchat, controls,
  } = deps;

  const destinations = () => ({
    whatsapp_status: async (item) => { await waWeb("/post-status", item.type === "text" ? { text: item.payload } : item.payload); },

    telegram_story: getTgClient() ? async (item) => {
      const pl = item.payload;
      await telegramStory.postStory(getTgClient(), { buffer: Buffer.from(pl.base64, "base64"), caption: pl.text, mimetype: pl.mimetype, video: pl.video });
    } : null,

    instagram_post: instagram.isConfigured() ? async (item) => {
      const hosted = await hostPublicJpeg(item.payload.base64);
      try { return await instagram.publishPhoto({ imageUrl: hosted.url, caption: item.payload.text || "" }); }
      finally { hosted.remove && hosted.remove(); }
    } : null,

    // Snapchat goes through BulkPublish (snapchat_publish.js): it needs the ORIGINAL library file at a public https URL.
    snapchat_story: snapchat && snapchat.isConfigured() ? async (item) => {
      const url = item.url;
      if (!/^https:\/\//i.test(String(url || ""))) throw new Error("Snapchat needs the library file's public https URL");
      if (!(item.type === "image" ? IMG_EXT : VID_EXT).test(url)) throw new Error(`Snapchat story takes ${item.type === "image" ? "jpg or png" : "mp4 or mov"} files (this one is ${String(url).split("?")[0].split(".").pop()})`);
      await snapchat.postStory(url);
    } : null,

    snapchat_spotlight: snapchat && snapchat.isConfigured() ? async (item) => {
      const url = item.url, v = item.payload && item.payload.video;
      if (!/^https:\/\//i.test(String(url || "")) || !VID_EXT.test(url)) throw new Error("Spotlight needs a library video (mp4 or mov) at a public https URL");
      if (!v || !(v.height > v.width)) throw new Error("Spotlight needs a vertical video; this one is not");
      const secs = v.sourceDuration || v.duration;
      if (!(secs >= 6 && secs <= 60)) throw new Error(`Spotlight needs a video between 6 and 60 seconds (this one is ${Math.round(secs)} s)`);
      await snapchat.postSpotlight(url, item.payload.text || "");
    } : null,
  });

  /** Dashboard switches: WhatsApp is always on; every other place needs to be set up AND switched on in "Her life". */
  const enabled = (dest) => {
    const c = controls().status;
    return dest === "whatsapp_status"
      || (dest === "telegram_story" && !!getTgClient() && c.telegramStory)
      || (dest === "instagram_post" && instagram.isConfigured() && c.instagram)
      || (dest === "snapchat_story" && !!snapchat && snapchat.isConfigured() && c.snapchatStory)
      || (dest === "snapchat_spotlight" && !!snapchat && snapchat.isConfigured() && c.snapchatSpotlight);
  };

  return { destinations, enabled };
}
module.exports = { create };
