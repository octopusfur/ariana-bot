"use strict";
/**
 * telegram_story.js -- puts one of her pictures on her Telegram Story (the 24h story, same idea as her WhatsApp Status),
 * visible to her Telegram contacts. Stories need media: her own pictures and videos only (see post_policy.js).
 * client = the linked GramJS TelegramClient. Never throws into the caller's flow beyond the error it returns to them.
 */
async function postStory(client, { buffer, caption, mimetype, video, lib } = {}) {
  if (!client) throw new Error("Telegram not connected");
  if (!buffer || !buffer.length) throw new Error("no picture or video to post");
  const { Api } = lib || require("telegram");
  const { CustomFile } = lib || require("telegram/client/uploads");
  const bigInt = (lib && lib.bigInt) || require("big-integer");
  const isVideo = /^video\//i.test(String(mimetype || ""));
  const file = await client.uploadFile({ file: new CustomFile(isVideo ? "story.mp4" : "story.jpg", buffer.length, "", buffer), workers: 1 });
  const media = isVideo
    ? new Api.InputMediaUploadedDocument({
        file, mimeType: "video/mp4",
        attributes: [new Api.DocumentAttributeVideo({ duration: Math.max(1, Math.round((video && video.duration) || 1)), w: (video && video.width) || 720, h: (video && video.height) || 1280, supportsStreaming: true })],
      })
    : new Api.InputMediaUploadedPhoto({ file });
  return client.invoke(new Api.stories.SendStory({
    peer: new Api.InputPeerSelf(),
    media,
    caption: caption ? String(caption).slice(0, 200) : undefined,
    privacyRules: [new Api.InputPrivacyValueAllowContacts()],
    randomId: bigInt(Date.now()).multiply(1000).add(Math.floor(Math.random() * 1000)),
    period: 86400,
  }));
}

module.exports = { postStory };
