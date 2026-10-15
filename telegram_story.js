"use strict";
/**
 * telegram_story.js -- puts one of her pictures on her Telegram Story (the 24h story, same idea as her WhatsApp Status),
 * visible to her Telegram contacts. Stories need media, so only picture posts are mirrored here.
 * client = the linked GramJS TelegramClient. Never throws into the caller's flow beyond the error it returns to them.
 */
async function postStory(client, { buffer, caption, lib } = {}) {
  if (!client) throw new Error("Telegram not connected");
  if (!buffer || !buffer.length) throw new Error("no picture to post");
  const { Api } = lib || require("telegram");
  const { CustomFile } = lib || require("telegram/client/uploads");
  const bigInt = (lib && lib.bigInt) || require("big-integer");
  const file = await client.uploadFile({ file: new CustomFile("story.jpg", buffer.length, "", buffer), workers: 1 });
  return client.invoke(new Api.stories.SendStory({
    peer: new Api.InputPeerSelf(),
    media: new Api.InputMediaUploadedPhoto({ file }),
    caption: caption ? String(caption).slice(0, 200) : undefined,
    privacyRules: [new Api.InputPrivacyValueAllowContacts()],
    randomId: bigInt(Date.now()).multiply(1000).add(Math.floor(Math.random() * 1000)),
    period: 86400,
  }));
}

module.exports = { postStory };
