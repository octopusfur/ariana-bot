"use strict";
/**
 * sticker_choice.js -- a sticker only ever goes out because SHE chose it. The reply tool has an optional "sticker" field
 * (a few words for the mood); when she fills it in, that is remembered here for the chat until the reply is sent.
 * Nothing in the app sends a sticker on its own (no random follow-ups, none forced because someone asked).
 */
function createStickerChoices({ now = Date.now, ttlMs = 2 * 60 * 1000 } = {}) {
  const picks = new Map();
  /** Record what the latest reply attempt chose (an empty/missing field means "no sticker" and clears an older attempt's pick). */
  function fromArgs(chat, args) {
    const mood = args && typeof args.sticker === "string" ? args.sticker.trim().replace(/\s+/g, " ").slice(0, 40) : "";
    if (mood) picks.set(chat, { mood, at: now() }); else picks.delete(chat);
  }
  /** The pick for this chat (once), or null. */
  function take(chat) {
    const p = picks.get(chat);
    picks.delete(chat);
    return p && now() - p.at < ttlMs ? p : null;
  }
  return { fromArgs, take };
}

module.exports = { createStickerChoices };
