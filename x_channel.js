// x_channel.js
// ─────────────────────────────────────────────────────────────────────────────
// X (Twitter) as a chat channel — the same way WhatsApp, Telegram and Snapchat
// are, but through the SOCIAL ENGINE Ariana already has (Browser Use or
// SocialCrabs). No extra service, no paid X API.
//
//   out:  her reply goes through the social layer's `dm` action, so every guard
//         she already has applies (creator switch, daily ceiling, dry-run, the
//         activity log). This module adds no way around them.
//   in:   X has no way to tell us a DM arrived unless you pay for its API, so
//         incoming DMs are PULLED: one `read_dms` call (a plain HTTP request to
//         X's inbox), when something asks for it.
//
// WHAT TRIGGERS A CHECK (nothing runs on its own by default):
//   · you press "Check messages now" in the dashboard   (POST /api/x/check)
//   · X_INBOX_POLL_MINUTES is set above 0               (off unless you opt in;
//     every check is one request to X's inbox, so it is cheap)
//
// SAFETY, because this is a real inbox:
//   · The FIRST check only learns what is already there and answers none of it,
//     so she never replies to your old history.
//   · She answers a conversation only when the engine says the LAST message was
//     NOT hers. If it can't tell, she stays quiet.
//   · Each message is marked answered BEFORE she replies: if something fails
//     midway she skips it rather than risk replying twice.
//   · At most X_INBOX_MAX_PER_CHECK (default 5) new conversations per check; the
//     rest wait for the next one.
//   · She does not message first on X unless X_PROACTIVE=on.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const accounts = require('./social/accounts');
const engine = require('./social/engine_client');
const tools = require('./social/tools');
const activity = require('./social/activity');
const store = require('./social/store');

const PREFIX = 'x_';
const DAY_MS = 24 * 60 * 60 * 1000;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const maxPerCheck = () => num(process.env.X_INBOX_MAX_PER_CHECK, 5);
const maxRepliesPerDay = () => num(process.env.X_CHANNEL_MAX_REPLIES_PER_DAY, 30);
const maxReadsPerDay = () => num(process.env.SOCIAL_MAX_READ_DMS, 40);
const pollMinutes = () => num(process.env.X_INBOX_POLL_MINUTES, 0);

const state = { running: false, last: null };

function normHandle(value) {
  const h = String(value == null ? '' : value).trim().replace(/^@/, '');
  return HANDLE.test(h) ? h : null;
}

const hashOf = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);

function isXId(id) { return String(id || '').startsWith(PREFIX); }
function handleFromId(id) { return String(id || '').replace(/^x_/, ''); }

// ── WHICH X ACCOUNT ─────────────────────────────────────────────────────────

async function xAccount() {
  const all = (await accounts.list()).filter((a) => a.platform === 'twitter');
  if (!all.length) {
    return { ok: false, code: 'no_account', error: 'No X account yet — add one in Social Accounts (platform X) and sign in.' };
  }
  const wanted = String(process.env.X_CHANNEL_ACCOUNT || '').trim().replace(/^@/, '').toLowerCase();
  const account = wanted ? all.find((a) => a.handle.toLowerCase() === wanted) : (all.find((a) => a.actions_enabled) || all[0]);
  if (!account) return { ok: false, code: 'no_account', error: `X_CHANNEL_ACCOUNT is "${wanted}" but no such X account is added.` };
  if (!account.actions_enabled) {
    return { ok: false, code: 'actions_disabled', error: `Actions are off for @${account.handle} — turn them on in Social Accounts so she can read and answer X messages.` };
  }
  return { ok: true, account };
}

// ── OUT ─────────────────────────────────────────────────────────────────────

async function sendText(to, text) {
  const handle = normHandle(handleFromId(to));
  if (!handle) throw new Error('X: not a valid handle to message.');
  const body = String(text || '').trim();
  if (!body) return;
  const acct = await xAccount();
  if (!acct.ok) throw new Error(acct.error);
  // Through the normal social tool, so the guards, the daily ceiling, dry-run and the
  // activity log all apply. The channel gets its own (higher) daily ceiling for `dm`.
  const res = await tools.executeTool(
    'social_dm',
    { username: handle, message: body, account: acct.account.account_id },
    { source: 'x-channel', actor: 'ariana', limits: { dm: maxRepliesPerDay() } },
  );
  if (!res.ok) throw new Error(res.error || `X message not sent (${res.code || 'failed'}).`);
}

// X direct messages cannot carry pictures through the engine; the caption still goes.
async function sendImage(to, _imageUrl, caption) {
  if (caption && String(caption).trim()) return sendText(to, caption);
  return undefined;
}

// ── IN ──────────────────────────────────────────────────────────────────────

// What the engine reports, reduced to what is safe to act on.
function readItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const from = normHandle(item.from);
    const text = String(item.last_message == null ? '' : item.last_message).trim();
    if (!from || !text) continue;
    // Only an explicit `false` counts as "she did not send the last one".
    out.push({ from, text, theirs: item.last_from_me === false, hash: hashOf(text) });
  }
  return out;
}

async function loadSeen() {
  const cfg = await store.loadConfig();
  const box = (cfg && cfg.x_inbox) || {};
  return { seen: box.seen && typeof box.seen === 'object' ? box.seen : {}, baselined: !!box.baselined };
}

async function saveSeen(seen, baselined) {
  const trimmed = Object.fromEntries(Object.entries(seen).slice(-500)); // bounded
  await store.saveConfig({ x_inbox: { seen: trimmed, baselined, updated_at: new Date().toISOString() } });
}

function finish(summary) {
  state.last = { at: new Date().toISOString(), ...summary };
  return summary;
}

// Reads the inbox ONCE and decides what is new. Returns { summary, fresh } — `fresh`
// are the messages to hand to the brain, already marked answered.
async function readInbox() {
  if (state.running) return { summary: finish({ ok: false, code: 'busy', error: 'A check is already running.' }), fresh: [] };
  state.running = true;
  try {
    const acct = await xAccount();
    if (!acct.ok) return { summary: finish({ ok: false, code: acct.code, error: acct.error }), fresh: [] };
    if (!engine.configured()) {
      return { summary: finish({ ok: false, code: 'not_configured', error: 'The social engine is not connected — ' + engine.configHint() }), fresh: [] };
    }
    if (process.env.SOCIAL_DRY_RUN === '1') {
      return { summary: finish({ ok: false, code: 'dry_run', error: 'Dry run is on — no inbox was read.' }), fresh: [] };
    }

    const reads = await activity.countSince(DAY_MS, { accountId: acct.account.account_id, action: 'read_dms' });
    if (reads >= maxReadsPerDay()) {
      return { summary: finish({ ok: false, code: 'daily_limit', error: `Inbox read limit reached (${reads}/${maxReadsPerDay()} in 24h) — raise SOCIAL_MAX_READ_DMS if you want more.` }), fresh: [] };
    }

    const started = Date.now();
    const r = await engine.act(acct.account, 'read_dms', {});
    const failed = !r.ok;
    await activity.record({
      account: acct.account, action: 'read_dms', target: 'inbox', target_handle: null,
      status: failed ? 'failed' : 'completed', error: failed ? r.error : null, actor: 'x-channel',
      duration_ms: Date.now() - started, detail: { source: 'x-channel' },
    });
    if (failed) {
      const hint = /unsupported|not supported|no handler|404|501/i.test(String(r.error || '') + String(r.code || ''))
        ? ' Your engine has no X inbox reader — sending DMs works, receiving needs the Browser Use engine.'
        : '';
      return { summary: finish({ ok: false, code: r.code || 'read_failed', error: (r.error || 'Could not read the X inbox.') + hint }), fresh: [] };
    }

    const items = readItems(r.result && r.result.items);
    const { seen, baselined } = await loadSeen();

    if (!baselined) {
      // First look: learn what is there, answer nothing.
      for (const it of items) seen[it.from] = it.hash;
      await saveSeen(seen, true);
      return { summary: finish({ ok: true, baseline: true, conversations: items.length, new: 0, answering: 0 }), fresh: [] };
    }

    const unseen = items.filter((it) => seen[it.from] !== it.hash);
    const toAnswer = unseen.filter((it) => it.theirs).slice(0, maxPerCheck());
    for (const it of unseen) {
      // Their own last message, or one we cannot attribute, is learned and never answered.
      if (!it.theirs) seen[it.from] = it.hash;
    }
    for (const it of toAnswer) seen[it.from] = it.hash; // marked BEFORE she replies
    if (unseen.length) await saveSeen(seen, true);

    return {
      summary: finish({ ok: true, baseline: false, conversations: items.length, new: unseen.length, answering: toAnswer.length, waiting: Math.max(0, unseen.filter((it) => it.theirs).length - toAnswer.length) }),
      fresh: toAnswer,
    };
  } catch (e) {
    return { summary: finish({ ok: false, code: 'check_failed', error: e.message }), fresh: [] };
  } finally {
    state.running = false;
  }
}

// Hands each new message to the brain, one at a time, as if it were any chat.
async function dispatch(fresh, onMessage) {
  for (const it of fresh) {
    console.log(`🐦 X @${it.from}: ${JSON.stringify(it.text.slice(0, 120))}`);
    try {
      await onMessage({ id: `${PREFIX}${it.from}`, platform: 'x', from: it.from, text: it.text, chatId: it.from, phoneNumberId: null, name: `@${it.from}` });
    } catch (e) {
      console.error('❌ X handle:', e.message);
    }
  }
}

async function checkInbox(onMessage) {
  const { summary, fresh } = await readInbox();
  const done = dispatch(fresh, onMessage);
  return { summary, done };
}

// ── STATUS + ROUTES ─────────────────────────────────────────────────────────

async function status() {
  const acct = await xAccount();
  const configured = engine.configured();
  const note = null;
  return {
    configured,
    engine: engine.provider(),
    can_receive: configured,
    account: acct.ok ? { account_id: acct.account.account_id, handle: acct.account.handle } : null,
    problem: acct.ok ? null : { code: acct.code, error: acct.error },
    polling_minutes: pollMinutes(),
    reply_ceiling_per_day: maxRepliesPerDay(),
    last_check: state.last,
    note,
  };
}

function init({ app, requireAuth, onMessage }) {
  app.get('/api/x/status', requireAuth, async (_req, res) => {
    try { res.json(await status()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The only manual trigger: answers as soon as the inbox has been read; replies continue in the background.
  app.post('/api/x/check', requireAuth, async (_req, res) => {
    try {
      const { summary } = await checkInbox(onMessage);
      res.status(summary.ok ? 200 : 409).json(summary);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  const minutes = pollMinutes();
  let timer = null;
  if (minutes > 0) {
    timer = setInterval(() => { checkInbox(onMessage).catch((e) => console.error('❌ X check:', e.message)); }, Math.max(1, minutes) * 60 * 1000);
    if (timer.unref) timer.unref();
    console.log(`🐦 X inbox: checking every ${minutes} min (X_INBOX_POLL_MINUTES) — each check is one engine run`);
  } else {
    console.log('🐦 X inbox: on demand only (nothing runs on a timer)');
  }
  return { stop: () => timer && clearInterval(timer) };
}

module.exports = {
  PREFIX, init, sendText, sendImage, isXId, handleFromId, checkInbox, readInbox, dispatch, status,
  // exposed for tests
  readItems, normHandle, _state: state,
};
