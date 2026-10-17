"use strict";
/**
 * reply_delay.js -- how long Ariana "takes" before answering.
 *  o Her owner always gets an instant answer.
 *  o Everyone else gets the human pause (8-20s for a short message, up to 30-70s for a long one, now and then +30s).
 *  o HUMAN_DELAY_SCALE (env) can shorten or stretch that pause for other people, but 0 / unset / junk means "normal",
 *    so a leftover "0" can never make her answer strangers instantly.
 */
function delayMs(message, { isOwner = false, scale = process.env.HUMAN_DELAY_SCALE, rand = Math.random } = {}) {
  if (isOwner) return 0;
  const len = String(message || "").trim().length;
  let min, max;
  if (len < 15) { min = 8000; max = 20000; }
  else if (len < 60) { min = 15000; max = 40000; }
  else { min = 30000; max = 70000; }
  if (rand() < 0.2) max += 30000;
  const s = parseFloat(scale);
  return Math.floor((Math.floor(rand() * (max - min + 1)) + min) * (s > 0 ? s : 1));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { delayMs, wait };
