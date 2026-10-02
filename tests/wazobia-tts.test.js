'use strict';
const test = require('node:test');
const assert = require('node:assert');
const w = require('../wazobia_tts');

const audio = Buffer.alloc(4096, 1);
const okHttp = (calls) => ({ post: async (url, body, opts) => { calls.push({ url, body, opts }); return { data: audio, headers: { 'content-type': 'audio/mpeg' } }; } });

test('disabled without WAZOBIA_TTS_URL, and for unsupported languages', async () => {
  assert.strictEqual(w.isEnabled({}), false);
  assert.strictEqual(await w.synthesize('hello', 'pcm', { env: {}, http: okHttp([]) }), null);
  assert.strictEqual(await w.synthesize('hello', 'en', { env: { WAZOBIA_TTS_URL: 'http://x' }, http: okHttp([]) }), null);
});

test('posts text + language_id with the bearer key and returns the audio', async () => {
  const calls = [];
  const r = await w.synthesize('Wetin dey happen 😂 https://x.co', 'pcm', { env: { WAZOBIA_TTS_URL: 'http://tts.example/', WAZOBIA_TTS_KEY: 'k' }, http: okHttp(calls) });
  assert.strictEqual(r.buffer.length, 4096);
  assert.strictEqual(calls[0].url, 'http://tts.example/tts');
  assert.strictEqual(calls[0].body.language_id, 'pcm');
  assert.strictEqual(calls[0].body.text, 'Wetin dey happen');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer k');
});

test('failures and non-audio replies return null so the caller can fall back', async () => {
  const env = { WAZOBIA_TTS_URL: 'http://x' };
  assert.strictEqual(await w.synthesize('hi', 'yo', { env, http: { post: async () => { throw new Error('boom'); } } }), null);
  assert.strictEqual(await w.synthesize('hi', 'yo', { env, http: { post: async () => ({ data: Buffer.from('{"error":"x"}'), headers: { 'content-type': 'application/json' } }) } }), null);
});

test('cleanForSpeech trims long text at a sentence boundary', () => {
  const long = ('This is a sentence. ').repeat(60);
  const out = w.cleanForSpeech(long);
  assert.ok(out.length <= 500);
  assert.ok(out.endsWith('.'));
});
