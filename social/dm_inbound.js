// social/dm_inbound.js
// ─────────────────────────────────────────────────────────────────────────────
// Who has messaged Ariana first, per platform. This is the whole basis of her rule
// on Instagram and TikTok: she answers people who write to her and NEVER opens a
// conversation. A name is added only when an inbound message from that person was
// actually seen (the DM poller), and it is kept in the same Supabase `sessions`
// table as everything else so a redeploy does not make her forget who wrote first.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const store = require('./store');

const TYPE = 'dm_inbound';
const loaded = new Map(); // platform -> { users: { name: iso }, dirty: bool }
let timer = null;

const norm = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase();

async function load(platform) {
  if (loaded.has(platform)) return loaded.get(platform);
  let data = null;
  try { data = await store.getSession(TYPE, platform); } catch (e) { console.warn(`[dm_inbound] could not load ${platform}: ${e.message}`); }
  const entry = { users: (data && data.users) || {}, dirty: false };
  loaded.set(platform, entry);
  return entry;
}

async function flush() {
  for (const [platform, entry] of loaded) {
    if (!entry.dirty) continue;
    entry.dirty = false;
    try { await store.setSession(TYPE, platform, { users: entry.users }); }
    catch (e) { entry.dirty = true; console.warn(`[dm_inbound] could not save ${platform}: ${e.message}`); }
  }
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, 5000);
  if (timer.unref) timer.unref();
}

async function markInbound(platform, username) {
  const u = norm(username);
  if (!u) return;
  const entry = await load(platform);
  if (!entry.users[u]) { entry.users[u] = new Date().toISOString(); entry.dirty = true; scheduleFlush(); }
}

async function hasInbound(platform, username) {
  const u = norm(username);
  if (!u) return false;
  return !!(await load(platform)).users[u];
}

function _reset() { loaded.clear(); if (timer) { clearTimeout(timer); timer = null; } }

module.exports = { markInbound, hasInbound, flush, norm, _reset };
