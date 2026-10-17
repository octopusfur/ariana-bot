// social/session_vault.js
// ─────────────────────────────────────────────────────────────────────────────
// Encrypted storage for platform login sessions (X cookies), in Supabase.
//
//   · AES-256-GCM, bound to the account id (a blob copied to another row will not decrypt).
//   · Key: X_SESSION_KEY if set, otherwise derived (HKDF) from SUPABASE_SERVICE_ROLE_KEY.
//     So a leaked database dump alone is useless; you need the server's environment too.
//   · The row holds ciphertext only. Where it lives is decided by store.js (Supabase table
//     ariana_social_config, or a local file when Supabase is not configured).
//
// Never throws. Every function resolves { ok: true, ... } or { ok: false, error, code }.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const store = require('./store');

const NAME = (accountId) => 'xsession:' + accountId;

function key() {
  const explicit = (process.env.X_SESSION_KEY || '').trim();
  if (explicit) return crypto.createHash('sha256').update(explicit).digest();
  const svc = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!svc) return null;
  return Buffer.from(crypto.hkdfSync('sha256', svc, 'ariana-social', 'x-session-v1', 32));
}

function available() { return !!key(); }

function seal(obj, accountId) {
  const k = key();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(accountId));
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(blob, accountId) {
  const k = key();
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(blob.iv, 'base64'));
  d.setAAD(Buffer.from(accountId));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(blob.data, 'base64')), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

const NO_KEY = { ok: false, code: 'no_key', error: 'No key to encrypt sessions with: set X_SESSION_KEY (any long random string), or configure SUPABASE_SERVICE_ROLE_KEY.' };

async function save(accountId, session) {
  if (!available()) return NO_KEY;
  try {
    const r = await store.saveSecret(NAME(accountId), seal({ ...session, saved_at: new Date().toISOString() }, accountId));
    return r.ok ? { ok: true, where: r.where } : { ok: false, code: 'store_failed', error: 'Could not save the session: ' + r.error };
  } catch (e) { return { ok: false, code: 'store_failed', error: 'Could not save the session: ' + e.message }; }
}

async function load(accountId) {
  if (!available()) return NO_KEY;
  try {
    const blob = await store.loadSecret(NAME(accountId));
    if (!blob) return { ok: true, session: null };
    return { ok: true, session: open(blob, accountId) };
  } catch (e) {
    return { ok: false, code: 'unreadable', error: 'A saved session exists but cannot be decrypted (was X_SESSION_KEY or the Supabase key changed?). Sign in again.' };
  }
}

async function remove(accountId) {
  try { await store.deleteSecret(NAME(accountId)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

async function list() {
  try { return (await store.listSecrets('xsession:')).map((n) => n.slice('xsession:'.length)); }
  catch (_) { return []; }
}

module.exports = { available, save, load, remove, list };
