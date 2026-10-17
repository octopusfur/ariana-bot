// social/api.js
// ─────────────────────────────────────────────────────────────────────────────
// The dashboard's side of the social layer.
//
// Mounted by index.js behind the same `requireDashboardAuth` that guards
// /api/owner-command and /api/talk — connecting an account or firing an action
// is exactly as sensitive as those, so it gets the same gate. When
// DASHBOARD_SECRET is not set the whole dashboard is open (that is Ariana's
// existing behaviour), which is why SOCIAL.md tells you to set it.
//
// Nothing here accepts a password. There is no field, route or parameter that
// carries platform credentials — sessions are provisioned server-side in the
// engine (see SOCIAL.md → Connecting an account).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const caps = require('./capabilities');
const accounts = require('./accounts');
const activity = require('./activity');
const guards = require('./guards');
const tools = require('./tools');
const engine = require('./engine_client');
const autonomy = require('./autonomy');

function ok(res, data) { res.json({ ok: true, ...data }); }
function fail(res, status, error, extra = {}) { res.status(status).json({ ok: false, error, ...extra }); }

// Where to send someone who wants to actually log the account in. Kept in one
// place so the dashboard, the docs and the error messages never drift.
// Only a capability list the dashboard can actually draw may be passed through from an
// engine: a list of platform objects that each carry supported/unsupported lists.
// Anything else (a keyed object, a bare list of names…) would blank the Social screen.
function usableManifest(m) {
  return !!(m && Array.isArray(m.platforms) && m.platforms.length
    && m.platforms.every((p) => p && typeof p === 'object' && p.id && Array.isArray(p.supported) && Array.isArray(p.unsupported)));
}

function attach(app, { requireAuth } = {}) {
  const r = express.Router();
  const guard = requireAuth || ((req, res, next) => next());

  const withCapabilities = (a) => ({
    ...a,
    capabilities: {
      supported: caps.supportedActions(a.platform),
      unsupported: caps.unsupportedActions(a.platform),
    },
  });

  // ── STATUS ──────────────────────────────────────────────────────────────
  r.get('/status', guard, async (_req, res) => {
    const [list, health] = await Promise.all([
      accounts.list(),
      engine.health(),
    ]);
    const autonomyCfg = await autonomy.getConfig();
    ok(res, {
      engine: {
        configured: engine.configured(),
        provider: engine.provider(),
        reachable: !!health.ok,
        error: health.ok ? null : health.error,
        health: health.ok ? health.health : null,
      },
      storage: { supabase: store_UsesSupabase(), data_dir: storeDataDir() },
      accounts: list.map((a) => ({
        account_id: a.account_id, platform: a.platform, handle: a.handle,
        actions_enabled: a.actions_enabled, status: a.status, status_detail: a.status_detail,
        last_checked: a.last_checked,
      })),
      autonomy: { enabled: !!autonomyCfg.enabled, interval_minutes: autonomyCfg.interval_minutes, ...autonomy.status() },
      dry_run: process.env.SOCIAL_DRY_RUN === '1',
      setup: (health.ok && health.health && health.health.login_configured) ? null : setupInstructions(),
    });
  });

  function store_UsesSupabase() { try { return require('./store').usingSupabase(); } catch (_) { return false; } }
  function storeDataDir() { try { return require('./store').DATA_DIR; } catch (_) { return null; } }

  function setupInstructions() {
    return {
      engine: 'built-in (x-lite): runs inside Ariana, no browser and no extra service.',
      steps: [
        '1. On the server, set X_PASSWORD for the X account (and X_EMAIL / X_TOTP_SECRET if it has an email check or an authenticator app).',
        '2. Redeploy, add the account here, then tap Connect. Ariana signs in by herself and saves the login (encrypted) in Supabase.',
        '3. If X asks for a verification code, a box appears on the account card: type the code from the account\'s email.',
      ],
      session_storage: 'The login is encrypted into your Supabase database, so redeploys and restarts do not sign her out. If X ever expires it, she signs in again on her own.',
    };
  }

  // ── CAPABILITIES ────────────────────────────────────────────────────────
  // Prefers the live engine's manifest; falls back to the bundled copy so the
  // dashboard can still be honest about what the integration supports while the
  // backend is not connected.
  r.get('/capabilities', guard, async (_req, res) => {
    const live = engine.configured() ? await engine.capabilities() : { ok: false };
    if (live.ok && usableManifest(live.capabilities)) {
      return ok(res, { source: 'engine', capabilities: live.capabilities, note: 'Reported by the running social engine.' });
    }
    ok(res, {
      source: 'bundled',
      capabilities: caps.describe(),
      note: engine.configured()
        ? 'The engine is unreachable — showing the bundled manifest that ships with Ariana.'
        : 'No engine connected — this is what the integration supports once you deploy one. Nothing can act until then.',
    });
  });

  // ── ACCOUNTS ────────────────────────────────────────────────────────────
  r.get('/accounts', guard, async (_req, res) => {
    const list = await accounts.list();
    const sessions = engine.configured() ? await engine.sessions() : { ok: false };
    const byId = new Map((sessions.sessions || []).map((s) => [s.account_id, s]));
    ok(res, {
      accounts: list.map((a) => ({
        ...withCapabilities(a),
        engine_session: engine.routesToIG(a)
          ? { on_demand: true, detail: 'Uses the Instagram service (no browser). It is only contacted when an action runs — press Connect to check it live.' }
          : sessions.ok ? (byId.get(a.account_id) || { connected: false, detail: 'No session on the engine yet.' }) : { reachable: false, detail: sessions.error },
      })),
    });
  });

  // Instagram and TikTok are Ariana's own to run: adding one turns her actions on straight away
  // (she likes, follows, unfollows, posts and replies to DMs; she never starts a DM — that rule is in
  // engine_client). The creator can still switch Actions off per account.
  const SELF_RUN = new Set(['instagram', 'tiktok']);

  r.post('/accounts', guard, async (req, res) => {
    const { platform, handle, label } = req.body || {};
    const result = await accounts.add({ platform, handle, label, actionsEnabled: SELF_RUN.has(String(platform || '').toLowerCase()) });
    if (!result.ok) return fail(res, 400, result.error);
    ok(res, { account: withCapabilities(result.account), ...(result.warning ? { warning: result.warning } : {}) });
  });

  // Easy connect for Instagram: sign in once with the account's username + password (+ a security code if
  // Instagram asks). The password is used for this one call and never stored; only the session is kept,
  // in Supabase. On success the account is created (if new), turned online and ready to act.
  r.post('/instagram/connect', guard, async (req, res) => {
    const { username, password, code } = req.body || {};
    if (!engine.ig.configured()) {
      return fail(res, 503, 'The Instagram service is not connected yet — ' + engine.ig.HINT);
    }
    const out = await engine.ig.login(username, password, code);
    if (!out.ok) return fail(res, out.code === 'bad_input' ? 400 : 502, out.error);
    if (!out.connected) {
      return ok(res, { connected: false, code: out.code, detail: out.detail, needs_code: out.code === 'two_factor' });
    }
    const id = 'instagram:' + out.handle;
    let account = await accounts.get(id);
    if (!account) {
      const added = await accounts.add({ platform: 'instagram', handle: out.handle, actionsEnabled: true });
      if (!added.ok) return fail(res, 500, added.error);
      account = added.account;
    }
    await accounts.setActionsEnabled(id, true);
    await accounts.setAutopublish(id, true);
    account = await accounts.setStatus(id, accounts.STATUS.ONLINE, out.detail) || account;
    ok(res, { connected: true, detail: out.detail, account: withCapabilities(account) });
  });

  r.delete('/accounts/:id', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    if (engine.configured()) await engine.disconnect(account);
    const removed = await accounts.remove(req.params.id);
    ok(res, { account: removed.account });
  });

  // Connect = make sure this account has a working X login. Ariana signs in by herself with the
  // credentials in the server environment (never typed into the dashboard). If X asks for a
  // verification code, the dashboard shows a box and posts it to /code.
  async function settleConnect(res, account, out) {
    const S = accounts.STATUS;
    if (!out.ok) {
      const soft = ['no_credentials', 'no_key', 'no_pending'].includes(out.code);
      const updated = await accounts.setStatus(account.account_id, soft ? S.NOT_CONNECTED : S.ERROR, out.error);
      return fail(res, soft ? 409 : 502, out.error, { account: updated, code: out.code });
    }
    if (out.needs_code) {
      const updated = await accounts.setStatus(account.account_id, S.NOT_CONNECTED, 'X wants a verification code. Enter it on this card.');
      return ok(res, { account: updated, connected: false, needs_code: true, kind: out.kind, prompt: out.prompt });
    }
    // A fresh sign-in is confirmed with one cheap call, so "Connected" always means "X accepts it".
    const v = out.detail ? { ok: true, session: { connected: true, detail: out.detail } } : await engine.verify(account);
    if (v.ok && v.session.connected) {
      const updated = await accounts.setStatus(account.account_id, S.ONLINE, v.session.detail);
      return ok(res, { account: updated, connected: true });
    }
    const why = v.ok ? v.session.detail : v.error;
    const updated = await accounts.setStatus(account.account_id, S.ERROR, 'Signed in, but X did not accept the new login: ' + why);
    return fail(res, 502, why, { account: updated, code: v.code });
  }

  // Instagram runs through its own service: the session was saved by Settings → Connect Instagram, so Connect
  // only checks that it is there and still works.
  async function connectInstagram(res, account) {
    const S = accounts.STATUS;
    const have = await engine.sessionStatus(account);
    if (!have.ok) {
      const updated = await accounts.setStatus(account.account_id, S.UNKNOWN, have.error);
      return fail(res, 502, have.error, { account: updated });
    }
    const s = have.session || {};
    if (!s.exists && !s.has_session) {
      const updated = await accounts.setStatus(account.account_id, S.NOT_CONNECTED, 'Not signed in yet. Open Settings → Connect Instagram.');
      return ok(res, { account: updated, connected: false, error: 'Not signed in yet. Open Settings → Connect Instagram.' });
    }
    const verified = await engine.verify(account);
    if (!verified.ok) {
      const updated = await accounts.setStatus(account.account_id, S.ERROR, verified.error);
      return fail(res, 502, verified.error, { account: updated });
    }
    const v = verified.session || {};
    if (v.connected) {
      const updated = await accounts.setStatus(account.account_id, S.ONLINE, v.detail || 'Session verified.');
      return ok(res, { account: updated, connected: true });
    }
    const updated = await accounts.setStatus(account.account_id, S.ERROR, v.detail || v.error || 'The platform says this session is not logged in.');
    return ok(res, { account: updated, connected: false, needs_reconnect: true, error: v.error || null });
  }

  // TikTok (opt-in, Browser Use Cloud): the creator signs in themselves on a live browser (no passwords through
  // Ariana). First tap opens that browser. After signing in, tap Connect again to save the login and verify it.
  async function connectViaBrowserUse(res, account) {
    const S = accounts.STATUS;
    const bu = engine.bu;
    let fin = null;
    if (bu.hasPendingLogin(account)) {
      fin = await bu.finishLogin(account);
      if (!fin.ok) return fail(res, 502, fin.error);
    } else {
      const st = await bu.sessionStatus(account);
      if (!st.ok) {
        const updated = await accounts.setStatus(account.account_id, S.UNKNOWN, st.error);
        return fail(res, 502, st.error, { account: updated });
      }
      if (st.session.exists) {
        const check = await bu.verify(account);
        if (check.ok && check.session.connected) {
          const updated = await accounts.setStatus(account.account_id, S.ONLINE, check.session.detail);
          return ok(res, { account: updated, connected: true });
        }
      }
      const login = await bu.startLogin(account);
      if (!login.ok) {
        const updated = await accounts.setStatus(account.account_id, S.ERROR, login.error);
        return fail(res, 502, login.error, { account: updated });
      }
      const updated = await accounts.setStatus(account.account_id, S.NOT_CONNECTED, 'Waiting for you to sign in on the live browser, then tap Connect again.');
      return ok(res, {
        account: updated, connected: false, login_url: login.live_url,
        instructions: [
          'A live browser just opened. Sign in to ' + account.platform + ' as @' + account.handle + ' yourself.',
          login.navigated ? 'It is already on the login page.' : 'Go to ' + login.login_page + ' in that browser.',
          'Wait until you can see your home feed, then close the browser and tap Connect again right away. The browser expires 30 minutes after it opened, and an expired browser loses the login.',
        ],
      });
    }
    const v = await (fin ? bu.verifyAfterLogin(account, fin) : bu.verify(account));
    if (!v.ok) {
      const updated = await accounts.setStatus(account.account_id, S.ERROR, v.error);
      return fail(res, 502, v.error, { account: updated });
    }
    if (v.session.connected) {
      const updated = await accounts.setStatus(account.account_id, S.ONLINE, v.session.detail);
      return ok(res, { account: updated, connected: true });
    }
    const updated = await accounts.setStatus(account.account_id, S.ERROR, v.session.detail);
    return ok(res, { account: updated, connected: false, needs_reconnect: true, error: v.session.detail });
  }

  r.post('/accounts/:id/connect', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    if (engine.routesToIG(account)) return connectInstagram(res, account);
    if (engine.routesToBU(account)) return connectViaBrowserUse(res, account);
    return settleConnect(res, account, await engine.connect(account));
  });

  r.post('/accounts/:id/code', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    const code = req.body && req.body.code;
    if (!code || !String(code).trim()) return fail(res, 400, 'Enter the code first.');
    return settleConnect(res, account, await engine.submitCode(account, code));
  });

  r.post('/accounts/:id/disconnect', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    const out = await engine.disconnect(account);
    const updated = await accounts.setStatus(account.account_id, accounts.STATUS.NOT_CONNECTED, out.ok ? 'Saved login deleted. Tap Connect to sign in again.' : out.error);
    if (!out.ok) return fail(res, 502, out.error, { account: updated });
    ok(res, { account: updated });
  });

  r.post('/accounts/:id/enable', guard, async (req, res) => {
    const out = await accounts.setActionsEnabled(req.params.id, true);
    if (!out.ok) return fail(res, 404, out.error);
    ok(res, { account: withCapabilities(out.account) });
  });

  r.post('/accounts/:id/disable', guard, async (req, res) => {
    const out = await accounts.setActionsEnabled(req.params.id, false);
    if (!out.ok) return fail(res, 404, out.error);
    ok(res, { account: withCapabilities(out.account) });
  });

  // Publishing is the one action with an extra creator switch, because it is
  // public and permanent. Off by default; only meaningful where posting exists.
  r.post('/accounts/:id/autopublish', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    if (!caps.supports(account.platform, 'post')) {
      return fail(res, 422, caps.unsupportedReason(account.platform, 'post') || `${caps.platformLabel(account.platform)} cannot publish through this integration.`);
    }
    const out = await accounts.setAutopublish(req.params.id, !!(req.body || {}).enabled);
    if (!out.ok) return fail(res, 400, out.error);
    ok(res, { account: withCapabilities(out.account) });
  });

  // ── ACTIVITY ────────────────────────────────────────────────────────────
  r.get('/activity', guard, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const account = req.query.account || null;
    ok(res, { activity: await activity.recent(limit, account) });
  });

  // ── CONFIRMATIONS ───────────────────────────────────────────────────────
  // A human in the dashboard mints a short-lived, single-use token; the guarded
  // action consumes it. Ariana cannot mint her own confirmations.
  r.get('/confirmations', guard, async (_req, res) => {
    ok(res, { confirmations: guards.listConfirmations(), ttl_ms: guards.CONFIRM_TTL_MS, batch_max: guards.BATCH_MAX });
  });

  r.post('/confirmations', guard, async (req, res) => {
    const { account_id, action, max_targets, note } = req.body || {};
    if (!action) return fail(res, 400, 'An action is required.');
    ok(res, guards.createConfirmation({ accountId: account_id, action, maxTargets: max_targets, note }));
  });

  // ── ACTIONS (manual, creator-driven) ────────────────────────────────────
  // Same executor Ariana uses. Available so the creator can test an action
  // end-to-end, or do something themselves through her accounts.
  r.post('/actions/:action', guard, async (req, res) => {
    const action = String(req.params.action || '').toLowerCase();
    const tool = tools.TOOL_FOR_ACTION[action];
    if (!tool) return fail(res, 404, `"${action}" is not an action Ariana can take. Known actions: ${Object.keys(tools.TOOL_FOR_ACTION).join(', ')}.`);
    const body = req.body || {};
    const result = await tools.executeTool(tool.name, body, {
      source: 'dashboard',
      actor: 'creator',
      accountHint: body.account || null,
      confirmationToken: body.confirmation_token || null,
    });
    if (!result.ok) {
      const status = result.code === 'not_configured' ? 503
        : result.code === 'unsupported' || result.code === 'unsupported_platform' ? 422
        : result.code === 'needs_confirmation' ? 409
        : 400;
      return res.status(status).json(result);
    }
    ok(res, { result });
  });

  // ── AUTONOMY ────────────────────────────────────────────────────────────
  r.get('/autonomy', guard, async (_req, res) => {
    ok(res, { autonomy: await autonomy.getConfig(), runtime: autonomy.status() });
  });

  r.post('/autonomy', guard, async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    ['interval_minutes', 'max_actions_per_tick', 'max_candidates_per_tick'].forEach((k) => {
      if (body[k] != null) patch[k] = Math.max(1, parseInt(body[k], 10) || undefined);
    });
    ['allow_comment', 'allow_follow'].forEach((k) => { if (typeof body[k] === 'boolean') patch[k] = body[k]; });
    if (body.watchlist && typeof body.watchlist === 'object') {
      patch.watchlist = {
        instagram: Array.isArray(body.watchlist.instagram) ? body.watchlist.instagram.map((h) => String(h).replace(/^@/, '').trim()).filter(Boolean).slice(0, 10) : [],
      };
    }
    if (Array.isArray(body.linkedin_searches)) {
      patch.linkedin_searches = body.linkedin_searches.map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
    }
    const next = await autonomy.setConfig(patch);
    ok(res, { autonomy: next });
  });

  r.post('/autonomy/run', guard, async (_req, res) => {
    ok(res, await autonomy.runOnce({ trigger: 'manual' }));
  });

  app.use('/api/social', r);
  return r;
}

module.exports = { attach, usableManifest };
