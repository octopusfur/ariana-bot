"use strict";
/**
 * story_publish.js — fan one post out to every place it is allowed to go.
 *  deps.destinations: { [dest]: async (item) => any }   the real senders (only the ones that exist are listed)
 *  deps.enabled(dest) -> bool                           dashboard switch + "is it configured" per destination
 *  deps.unavailable: { [dest]: 'reason' }               destinations that cannot work yet (shown, never faked)
 * WhatsApp status goes first and decides success; the rest are best effort and never block or fail it.
 * Returns [{ dest, ok, skipped?, error? }].
 */
const policy = require("./post_policy");

async function publish(item, deps, { only = null } = {}) {
  const results = [];
  const wanted = (only ? policy.DESTINATIONS.filter((d) => only.includes(d)) : policy.DESTINATIONS);
  for (const dest of wanted) {
    if (!policy.isAllowed(dest, item)) { if (only) results.push({ dest, ok: false, skipped: `not allowed: ${item.source} ${item.type}` }); continue; }
    if (deps.unavailable && deps.unavailable[dest]) { results.push({ dest, ok: false, skipped: deps.unavailable[dest] }); continue; }
    const send = deps.destinations && deps.destinations[dest];
    if (!send) { if (only) results.push({ dest, ok: false, skipped: "not set up" }); continue; }
    if (!only && deps.enabled && !deps.enabled(dest)) continue; // switched off: silent for automatic posts
    if (only && deps.enabled && !deps.enabled(dest)) { results.push({ dest, ok: false, skipped: "switched off or not set up" }); continue; }
    try { await send(item); results.push({ dest, ok: true }); }
    catch (e) {
      results.push({ dest, ok: false, error: String(e.message || e).slice(0, 160) });
      console.warn(`[post] ${dest} failed: ${String(e.message || e).slice(0, 160)}`);
      if (dest === "whatsapp_status") break; // primary failed: do not mirror something that never went out
    }
  }
  return results;
}
module.exports = { publish };
