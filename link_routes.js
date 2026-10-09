'use strict';
/**
 * Dashboard account linking — Telegram (real user account via gramjs) and Signal (signal-cli-rest-api).
 *
 * Everything is driven from Settings in the dashboard; no env edits or redeploys:
 *   Telegram: phone → code (+2FA password if set) → session saved to Supabase `sessions`
 *             (type 'telegram') and the live client is restarted with it.
 *   Signal:   link as a secondary device (tap-to-open link / QR) or register a number
 *             (captcha + SMS code) → number saved to `sessions` (type 'signal').
 *
 * `sessions` has RLS on and no policies, so only the server (service role) can read it.
 * Secrets (session strings, codes, passwords) are never logged.
 */

const PENDING_TTL_MS = 10 * 60 * 1000;

function cleanPhone(p) {
  const digits = String(p || '').replace(/[^\d]/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {Function} deps.requireAuth        dashboard auth middleware
 * @param {Function} deps.getSupabase        () => supabase client | null
 * @param {object}   deps.http               axios-like { get, post }
 * @param {object}   deps.telegram           { getClient: () => live client|null, reinit: async () => void, lib?: gramjs }
 * @param {object}   deps.signal             { getUrl, getNumber, setNumber: async (n) => void, setupWebhook?: async () => void }
 */
function register(app, deps) {
  const { requireAuth, getSupabase, http } = deps;
  const tg = deps.telegram;
  const sg = deps.signal;

  const tgLib = () => deps.telegram.lib || require('telegram');
  const tgSessions = () => deps.telegram.sessions || require('telegram/sessions');

  // ── persistence ──────────────────────────────────────────────
  async function saveSession(type, data) {
    const sb = getSupabase();
    if (!sb) return false;
    const { error } = await sb.from('sessions').upsert(
      { type, key: 'default', data, updated_at: new Date().toISOString() },
      { onConflict: 'type,key' }
    );
    if (error) { console.warn(`[link] could not persist ${type}:`, error.message); return false; }
    return true;
  }
  async function deleteSession(type) {
    const sb = getSupabase();
    if (!sb) return;
    try { await sb.from('sessions').delete().eq('type', type).eq('key', 'default'); } catch (_) {}
  }

  // ── TELEGRAM ─────────────────────────────────────────────────
  let pendingTg = null; // { client, phone, phoneCodeHash, apiId, apiHash, ts }

  function tgCreds() {
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    return apiId && apiHash ? { apiId, apiHash } : null;
  }
  async function dropPendingTg() {
    const p = pendingTg; pendingTg = null;
    if (p?.client) { try { await p.client.disconnect(); } catch (_) {} }
  }

  app.get('/api/telegram/status', requireAuth, async (_req, res) => {
    const live = tg.getClient();
    let user = null;
    if (live) { try { const me = await live.getMe(); user = me.username ? '@' + me.username : (me.firstName || null); } catch (_) {} }
    res.json({ credentials: !!tgCreds(), connected: !!live, user });
  });

  app.post('/api/telegram/send-code', requireAuth, async (req, res) => {
    const creds = tgCreds();
    if (!creds) return res.status(400).json({ error: 'TELEGRAM_API_ID / TELEGRAM_API_HASH are not set on the server.' });
    const phone = cleanPhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Enter the full number with country code.' });
    try {
      await dropPendingTg();
      const { TelegramClient } = tgLib();
      const { StringSession } = tgSessions();
      const client = new TelegramClient(new StringSession(''), creds.apiId, creds.apiHash, { connectionRetries: 3 });
      await client.connect();
      const r = await client.sendCode(creds, phone);
      pendingTg = { client, phone, phoneCodeHash: r.phoneCodeHash, ...creds, ts: Date.now() };
      res.json({ ok: true, viaApp: !!r.isCodeViaApp });
    } catch (e) {
      await dropPendingTg();
      res.status(502).json({ error: e.errorMessage || e.message || 'Could not send the code.' });
    }
  });

  app.post('/api/telegram/verify', requireAuth, async (req, res) => {
    const p = pendingTg;
    if (!p || Date.now() - p.ts > PENDING_TTL_MS) { await dropPendingTg(); return res.status(400).json({ error: 'Code expired — request a new one.' }); }
    const code = String(req.body?.code || '').replace(/\D/g, '');
    const password = req.body?.password ? String(req.body.password) : '';
    if (!code && !password) return res.status(400).json({ error: 'Enter the code Telegram sent you.' });
    try {
      const { Api } = tgLib();
      try {
        if (code) await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: code }));
        else throw Object.assign(new Error('pw'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
      } catch (e) {
        if (e.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw e;
        if (!password) return res.json({ needPassword: true }); // keep pending; client resubmits with password
        await p.client.signInWithPassword(
          { apiId: p.apiId, apiHash: p.apiHash },
          { password: async () => password, onError: async (err) => { throw err; } }
        );
      }
      const session = p.client.session.save();
      await dropPendingTg();
      process.env.TELEGRAM_SESSION = session;
      const persisted = await saveSession('telegram', { session });
      await tg.reinit().catch((e) => console.warn('[link] telegram reinit failed:', e.message));
      // Only hand the string back if we could not store it — it is the keys to the account.
      res.json({ ok: true, persisted, connected: !!tg.getClient(), ...(persisted ? {} : { session }) });
    } catch (e) {
      const msg = e.errorMessage || e.message || 'Sign-in failed.';
      if (/PHONE_CODE_(INVALID|EXPIRED)|PASSWORD_HASH_INVALID/.test(msg)) return res.status(400).json({ error: msg });
      await dropPendingTg();
      res.status(502).json({ error: msg });
    }
  });

  app.post('/api/telegram/unlink', requireAuth, async (_req, res) => {
    await dropPendingTg();
    process.env.TELEGRAM_SESSION = '';
    await deleteSession('telegram');
    await tg.reinit().catch(() => {}); // with no session this disconnects and clears the live client
    res.json({ ok: true });
  });

  // ── SIGNAL ───────────────────────────────────────────────────
  const sgGet = (path, opts) => http.get(`${sg.getUrl()}${path}`, { timeout: 20000, ...opts });
  const sgPost = (path, body, opts) => http.post(`${sg.getUrl()}${path}`, body, { timeout: 30000, ...opts });
  const plainErr = (t) => {
    t = String(t == null ? '' : t);
    if (/<\s*(!doctype|html|head|body)/i.test(t)) return /cloudflare|just a moment|challenge/i.test(t) ? 'blocked by a security check' : 'returned a web page instead of an answer';
    return t.replace(/\s+/g, ' ').trim().slice(0, 160);
  };
  const sgErr = (e) => plainErr(e.response?.data?.error || (typeof e.response?.data === 'string' ? e.response.data : '') || e.message);

  app.get('/api/signal/status', requireAuth, async (_req, res) => {
    const number = sg.getNumber();
    try {
      const r = await sgGet('/v1/accounts');
      const accounts = Array.isArray(r.data) ? r.data.map(String) : [];
      res.json({ reachable: true, number, accounts, linked: !!number && accounts.includes(number) });
    } catch (e) {
      res.json({ reachable: false, number, accounts: [], linked: false, error: sgErr(e) });
    }
  });

  // Link Ariana as a secondary device to a Signal account that lives on your phone.
  // On an iPhone you can't scan a QR shown on the same screen, so we return the raw
  // sgnl:// link (tap to open Signal) as well as the QR image.
  app.get('/api/signal/link', requireAuth, async (req, res) => {
    const name = String(req.query.name || 'Ariana').slice(0, 40);
    const out = { ok: true };
    try {
      const raw = await sgGet(`/v1/qrcodelink/raw?device_name=${encodeURIComponent(name)}`);
      const uri = typeof raw.data === 'string' ? raw.data : raw.data?.device_link_uri;
      if (uri && /^sgnl:\/\/linkdevice/.test(uri)) out.uri = uri;
    } catch (_) { /* older signal-cli-rest-api: QR image only */ }
    if (!out.uri) {
      try {
        const png = await sgGet(`/v1/qrcodelink?device_name=${encodeURIComponent(name)}`, { responseType: 'arraybuffer' });
        out.qr = `data:image/png;base64,${Buffer.from(png.data).toString('base64')}`;
      } catch (e) {
        return res.status(502).json({ error: sgErr(e) || 'signal-cli is not reachable.' });
      }
    }
    res.json(out);
  });

  // Register a brand-new number with Signal (needs a captcha from signalcaptchas.org most of the time).
  app.post('/api/signal/register', requireAuth, async (req, res) => {
    const number = cleanPhone(req.body?.number);
    if (!number) return res.status(400).json({ error: 'Enter the full number with country code.' });
    const body = { use_voice: !!req.body?.voice };
    const captcha = String(req.body?.captcha || '').trim().replace(/^signalcaptcha:\/\//, '');
    if (captcha) body.captcha = captcha;
    try {
      await sgPost(`/v1/register/${encodeURIComponent(number)}`, body);
      res.json({ ok: true });
    } catch (e) {
      const msg = sgErr(e);
      res.status(e.response?.status === 402 || /captcha/i.test(msg) ? 400 : 502).json({
        error: msg, needCaptcha: /captcha/i.test(msg),
      });
    }
  });

  app.post('/api/signal/verify', requireAuth, async (req, res) => {
    const number = cleanPhone(req.body?.number);
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (!number || !code) return res.status(400).json({ error: 'Enter the number and the code you received.' });
    try {
      const body = req.body?.pin ? { pin: String(req.body.pin) } : {};
      await sgPost(`/v1/register/${encodeURIComponent(number)}/verify/${code}`, body);
      await sg.setNumber(number);
      await saveSession('signal', { number });
      if (sg.setupWebhook) await sg.setupWebhook().catch(() => {});
      res.json({ ok: true, number });
    } catch (e) {
      res.status(e.response?.status === 400 ? 400 : 502).json({ error: sgErr(e) });
    }
  });

  // After linking as a secondary device the new account shows up in /v1/accounts — pick which one Ariana uses.
  app.post('/api/signal/use-number', requireAuth, async (req, res) => {
    const number = cleanPhone(req.body?.number);
    if (!number) return res.status(400).json({ error: 'Enter the full number with country code.' });
    try {
      const r = await sgGet('/v1/accounts');
      const accounts = Array.isArray(r.data) ? r.data.map(String) : [];
      if (!accounts.includes(number)) return res.status(400).json({ error: 'That number is not linked on the Signal server yet.' });
      await sg.setNumber(number);
      await saveSession('signal', { number });
      if (sg.setupWebhook) await sg.setupWebhook().catch(() => {});
      res.json({ ok: true, number });
    } catch (e) {
      res.status(502).json({ error: sgErr(e) });
    }
  });
}

/** Startup: dashboard-linked values win over env, so a redeploy never undoes a link. */
async function loadLinkedSessions(supabase) {
  const out = {};
  if (!supabase) return out;
  try {
    const { data } = await supabase.from('sessions').select('type,data').in('type', ['telegram', 'signal']).eq('key', 'default');
    for (const row of data || []) {
      if (row.type === 'telegram' && row.data?.session) out.telegramSession = row.data.session;
      if (row.type === 'signal' && row.data?.number) out.signalNumber = row.data.number;
    }
  } catch (e) { console.warn('[link] could not load linked sessions:', e.message); }
  return out;
}

module.exports = { register, loadLinkedSessions, cleanPhone };
