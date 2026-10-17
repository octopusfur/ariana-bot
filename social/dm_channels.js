// social/dm_channels.js
// ─────────────────────────────────────────────────────────────────────────────
// Instagram and TikTok DMs as conversations, the same way WhatsApp, Telegram and
// Snapchat are: a message in becomes a conversation in the dashboard (id `ig_<user>`
// / `tt_<user>`), goes through the same brain (handleMessage), and her reply goes
// back out through the same engine that holds the account.
//
//   inbound : a poller. Neither platform pushes messages to a personal account, so this
//             asks for the inbox on a gentle, jittered interval — Instagram every ~2 min
//             (IG_DM_POLL_S), TikTok only if you turn it on (TIKTOK_DM_POLL_MIN, it runs a
//             cloud browser each time, so it costs credits).
//   outbound: sendText / sendImage → engine.act(account, 'dm', …, { reply: true }).
//   the rule: she NEVER starts a conversation. Only people seen writing to her are
//             recorded (social/dm_inbound.js); engine_client refuses any other DM, and the
//             Instagram service checks the inbox again on its side.
//
// First run per account is history only: everything already in the inbox is remembered and
// nothing old is answered. Messages older than IG_DM_MAX_AGE_H (default 12) are never answered.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const engine = require('./engine_client');
const accounts = require('./accounts');
const inbound = require('./dm_inbound');
const store = require('./store');

const PREFIX = { instagram: 'ig_', tiktok: 'tt_' };
const SEEN_TYPE = 'dm_seen';
const MAX_SEEN = 500;
const CHUNK = 900;

const num = (raw, fallback) => { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const igPollMs = () => Math.max(45, num(process.env.IG_DM_POLL_S, 120)) * 1000;
const ttPollMs = () => num(process.env.TIKTOK_DM_POLL_MIN, 0) * 60000; // 0 = off
const maxAgeMs = () => num(process.env.IG_DM_MAX_AGE_H, 12) * 3600000;
const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

const convId = (platform, username) => `${PREFIX[platform]}${inbound.norm(username)}`;

const lastAccount = new Map(); // conversation id -> account_id that received the message
const seenCache = new Map();   // account_id -> { ids: Set, seeded, dirty }

// ── SEEN STATE ──────────────────────────────────────────────────────────────

async function loadSeen(accountId) {
  if (seenCache.has(accountId)) return seenCache.get(accountId);
  let d = null;
  try { d = await store.getSession(SEEN_TYPE, accountId); } catch (_) { /* start fresh: history-only run */ }
  const entry = { ids: new Set((d && d.ids) || []), seeded: !!(d && d.seeded), dirty: false };
  seenCache.set(accountId, entry);
  return entry;
}

async function saveSeen(accountId, entry) {
  if (!entry.dirty) return;
  entry.dirty = false;
  const ids = [...entry.ids].slice(-MAX_SEEN);
  entry.ids = new Set(ids);
  try { await store.setSession(SEEN_TYPE, accountId, { ids, seeded: entry.seeded }); }
  catch (e) { entry.dirty = true; console.warn(`[dm] could not save progress for ${accountId}: ${e.message}`); }
}

// ── OUTBOUND ────────────────────────────────────────────────────────────────

async function accountFor(platform, username) {
  const list = (await accounts.list()).filter((a) => a.platform === platform && a.actions_enabled);
  const mapped = lastAccount.get(convId(platform, username));
  return list.find((a) => a.account_id === mapped) || list[0] || null;
}

function chunks(text) {
  const s = String(text || '').trim();
  const out = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
  return out;
}

async function sendText(platform, username, text) {
  const acc = await accountFor(platform, username);
  if (!acc) throw new Error(`No ${platform} account with actions enabled — turn Actions on in Settings.`);
  for (const part of chunks(text)) {
    const r = await engine.act(acc, 'dm', { username: inbound.norm(username), message: part }, { reply: true });
    if (!r.ok) throw new Error(r.error || `${platform} message failed`);
  }
}

// Neither platform's DM path here carries a picture, so a photo goes as its caption plus the link.
async function sendImage(platform, username, imageUrl, caption) {
  await sendText(platform, username, [caption, imageUrl].filter(Boolean).join('\n'));
}

const typing = () => {};

// ── INBOUND ─────────────────────────────────────────────────────────────────

function ageOk(iso) {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || Date.now() - t <= maxAgeMs();
}

// One pass over one account. Returns { ok, fresh } — `fresh` is what was handed to the brain.
async function pollAccountOnce(account, { onMessage, cycle = 0 } = {}) {
  const platform = account.platform;
  const seen = await loadSeen(account.account_id);
  const found = []; // { username, text, key, at }

  if (platform === 'instagram') {
    const r = await engine.ig.inbox(account, { includeRequests: cycle % 3 === 0 });
    if (!r.ok) return r;
    for (const t of r.threads) {
      for (const m of [...(t.messages || [])].reverse()) { // service sends newest first
        if (!m.from_them) continue;
        await inbound.markInbound('instagram', t.username);
        found.push({ username: t.username, text: m.text, key: m.id, at: m.at });
      }
    }
  } else if (platform === 'tiktok') {
    const r = await engine.act(account, 'read_dms', {});
    if (!r.ok) return r;
    const items = (r.result && (r.result.items || (r.result.data && r.result.data.items))) || [];
    for (const it of items) {
      const username = inbound.norm(it && it.from);
      const text = String((it && it.last_message) || '').trim();
      if (!username || !text) continue;
      await inbound.markInbound('tiktok', username);
      found.push({ username, text, key: crypto.createHash('sha1').update(`${username}|${text}`).digest('hex'), at: null });
    }
  } else {
    return { ok: false, code: 'unsupported', error: `No DM channel for ${platform}.` };
  }

  const fresh = [];
  for (const f of found) {
    if (seen.ids.has(f.key)) continue;
    seen.ids.add(f.key);
    seen.dirty = true;
    if (seen.seeded && ageOk(f.at) && f.text) fresh.push(f);
  }
  if (!seen.seeded) { seen.seeded = true; seen.dirty = true; } // first run: remember history, answer none of it
  await saveSeen(account.account_id, seen);

  for (const f of fresh) {
    lastAccount.set(convId(platform, f.username), account.account_id);
    try {
      await onMessage({ id: convId(platform, f.username), platform, from: f.username, text: f.text, chatId: f.username, phoneNumberId: null, name: f.username });
    } catch (e) {
      console.error(`❌ ${platform} DM handling failed for @${f.username}: ${e.message}`);
    }
  }
  return { ok: true, fresh };
}

// ── LOOPS ───────────────────────────────────────────────────────────────────

function init({ onMessage }) {
  const timers = {};
  const backoff = { instagram: 1, tiktok: 1 };
  const cycles = { instagram: 0, tiktok: 0 };
  let stopped = false;

  async function tick(platform, baseMs) {
    let worst = null;
    try {
      const list = (await accounts.list()).filter((a) => a.platform === platform && a.actions_enabled);
      for (const acc of list) {
        const r = await pollAccountOnce(acc, { onMessage, cycle: cycles[platform] });
        if (r.ok) continue;
        if (r.code === 'no_session' || r.code === 'not_configured') continue; // not connected yet: nothing to say
        worst = r;
        if (['session_expired', 'challenge'].includes(r.code)) {
          await accounts.setStatus(acc.account_id, accounts.STATUS.ERROR, r.error).catch(() => {});
        }
        console.warn(`[dm] ${platform} @${acc.handle}: ${r.code} — ${r.error}`);
      }
    } catch (e) {
      worst = { code: 'poll_crashed', error: e.message };
      console.warn(`[dm] ${platform} poll failed: ${e.message}`);
    }
    cycles[platform] += 1;
    backoff[platform] = worst ? Math.min(backoff[platform] * 2, 8) : 1; // slow down while something is wrong
    schedule(platform, baseMs);
  }

  function schedule(platform, baseMs) {
    if (stopped || !baseMs) return;
    timers[platform] = setTimeout(() => tick(platform, baseMs), jitter(baseMs * backoff[platform]));
    if (timers[platform].unref) timers[platform].unref();
  }

  function start() {
    stopped = false;
    if (engine.ig.configured()) {
      console.log(`💬 Instagram DMs: polling about every ${Math.round(igPollMs() / 1000)}s while an account is connected`);
      schedule('instagram', igPollMs());
    }
    if (ttPollMs() > 0) {
      console.log(`💬 TikTok DMs: polling every ~${Math.round(ttPollMs() / 60000)} min (each poll runs a cloud browser)`);
      schedule('tiktok', ttPollMs());
    } else {
      console.log('💬 TikTok DMs: not polled (set TIKTOK_DM_POLL_MIN, e.g. 30, to bring them into the dashboard)');
    }
  }

  function stop() { stopped = true; for (const t of Object.values(timers)) clearTimeout(t); }

  return { start, stop };
}

function _reset() { lastAccount.clear(); seenCache.clear(); }

module.exports = { init, sendText, sendImage, typing, convId, pollAccountOnce, PREFIX, _reset };
