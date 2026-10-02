'use strict';
// Groq retired llama-3.3-70b-versatile on 2026-08-16. Keep a chain so the next retirement doesn't silence her.
const DEFAULT_CHAIN = ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'];

function modelChain(env = process.env) {
  const first = String(env.GROQ_MODEL || '').trim();
  return [...new Set([first, ...DEFAULT_CHAIN].filter(Boolean))];
}
function isModelGone(err) {
  const text = String((err && err.message) || '') + JSON.stringify((err && err.error) || {});
  return (err && err.status === 404) || /model_not_found|model_decommissioned|does not exist or you do not have access/i.test(text);
}
function paramsFor(model, base) {
  const p = { ...base, model };
  if (/gpt-oss/i.test(model)) { p.reasoning_effort = 'low'; p.max_tokens = Math.max(base.max_tokens || 0, 1024); }
  return p;
}
module.exports = { modelChain, isModelGone, paramsFor, DEFAULT_CHAIN };
