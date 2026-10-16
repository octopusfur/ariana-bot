"use strict";
/**
 * post_policy.js — which of Ariana's media may go where. Enforced in code, not in a prompt.
 *
 *   item = { source: 'library' | 'internet' | 'owner' | 'text', type: 'image' | 'video' | 'text' }
 *     library  = one of HER OWN pictures/videos from the dashboard media library
 *     internet = something funny found online (GIF / meme)
 *     owner    = a picture/video the owner sent her in chat and asked her to post
 *
 *   WhatsApp status   everything (text, her media, internet finds, owner-sent media)
 *   Telegram story    only her own pictures and videos
 *   Snapchat story    only her own pictures and videos
 *   Snapchat spotlight only her own videos (Snapchat does not take pictures there)
 *   Instagram post    only her own pictures (no video, nothing from the internet)
 */
const RULES = {
  whatsapp_status:    { sources: ["library", "internet", "owner", "text"], types: ["text", "image", "video"] },
  telegram_story:     { sources: ["library"], types: ["image", "video"] },
  snapchat_story:     { sources: ["library"], types: ["image", "video"] },
  snapchat_spotlight: { sources: ["library"], types: ["video"] }, // Spotlight only takes video (see snapchat_publish.js)
  instagram_post:     { sources: ["library"], types: ["image"] },
};
const DESTINATIONS = Object.keys(RULES);

function isAllowed(dest, item) {
  const r = RULES[dest];
  return !!(r && item && r.sources.includes(item.source) && r.types.includes(item.type));
}
/** Every destination this item is allowed to go to (WhatsApp status first). */
const destinationsFor = (item) => DESTINATIONS.filter((d) => isAllowed(d, item));
function assertAllowed(dest, item) {
  if (!isAllowed(dest, item)) throw new Error(`policy: ${item && item.type} from ${item && item.source} may not go to ${dest}`);
}
module.exports = { RULES, DESTINATIONS, isAllowed, destinationsFor, assertAllowed };
