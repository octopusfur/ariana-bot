'use strict';
/**
 * WazobiaVoice TTS client — Nigerian Pidgin ('pcm') and Yoruba ('yo') speech.
 *
 * WazobiaVoice (github.com/Ememzyvisuals/wazobiavoice-TTS) is a GPU PyTorch model, so it
 * can't run inside Ariana's Node process on Render. It runs as its own small service
 * (see wazobia-service/) and Ariana calls it over HTTP:
 *
 *   POST {WAZOBIA_TTS_URL}/tts   { text, language_id, exaggeration?, cfg_weight? }
 *   → audio/mpeg bytes
 *
 * Env: WAZOBIA_TTS_URL (required to enable), WAZOBIA_TTS_KEY (shared secret, sent as Bearer),
 *      WAZOBIA_TTS_TIMEOUT_MS (default 90000 — a cold GPU can take a while).
 * Never logs the URL's credentials or the key.
 */
const axios = require('axios');

const SUPPORTED = new Set(['pcm', 'yo', 'ha', 'ig']);
const MAX_CHARS = 500; // long clips get slow and drift; voice notes are short anyway

function isEnabled(env = process.env) {
  return !!String(env.WAZOBIA_TTS_URL || '').trim();
}

function supportsLanguage(lang) {
  return SUPPORTED.has(lang);
}

// Emoji, URLs and markdown noise are read aloud badly (or not at all) — strip them first.
function cleanForSpeech(text) {
  let t = String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[*_~`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > MAX_CHARS) {
    const cut = t.slice(0, MAX_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf(', '));
    t = (lastStop > 150 ? cut.slice(0, lastStop + 1) : cut).trim();
  }
  return t;
}

/**
 * @returns {Promise<{buffer: Buffer, contentType: string}|null>} null on any failure (caller falls back).
 */
async function synthesize(text, languageId, { env = process.env, http = axios } = {}) {
  if (!isEnabled(env) || !supportsLanguage(languageId)) return null;
  const clean = cleanForSpeech(text);
  if (!clean) return null;

  const base = String(env.WAZOBIA_TTS_URL).trim().replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Accept: 'audio/mpeg' };
  if (env.WAZOBIA_TTS_KEY) headers.Authorization = `Bearer ${env.WAZOBIA_TTS_KEY}`;

  try {
    const res = await http.post(
      `${base}/tts`,
      { text: clean, language_id: languageId, exaggeration: 0.55, cfg_weight: 0.55 },
      { headers, responseType: 'arraybuffer', timeout: Number(env.WAZOBIA_TTS_TIMEOUT_MS) || 90000 }
    );
    const buffer = Buffer.from(res.data || []);
    const contentType = String((res.headers && res.headers['content-type']) || 'audio/mpeg');
    // A JSON error body or empty reply must never be uploaded as a "voice note".
    if (buffer.length < 1000 || !/^audio\//i.test(contentType)) {
      console.warn(`[wazobia] bad response (${buffer.length} bytes, ${contentType})`);
      return null;
    }
    return { buffer, contentType };
  } catch (e) {
    console.warn('[wazobia] synth failed:', e.code || e.response?.status || e.message);
    return null;
  }
}

module.exports = { isEnabled, supportsLanguage, cleanForSpeech, synthesize };
