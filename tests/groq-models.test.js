const test = require('node:test');
const assert = require('node:assert');
const { modelChain, isModelGone, paramsFor } = require('../groq_models');

test('chain defaults to current Groq models, never the retired llama', () => {
  const c = modelChain({});
  assert.strictEqual(c[0], 'openai/gpt-oss-120b');
  assert.ok(!c.includes('llama-3.3-70b-versatile'));
});
test('GROQ_MODEL is tried first and not duplicated', () => {
  assert.deepStrictEqual(modelChain({ GROQ_MODEL: 'qwen/qwen3.6-27b' }).slice(0, 2), ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b']);
  assert.strictEqual(modelChain({ GROQ_MODEL: 'openai/gpt-oss-120b' }).filter(m => m === 'openai/gpt-oss-120b').length, 1);
});
test('detects a retired model but not other failures', () => {
  assert.ok(isModelGone({ status: 404, message: '404 model_not_found' }));
  assert.ok(isModelGone({ message: 'The model `x` does not exist or you do not have access to it.' }));
  assert.ok(!isModelGone({ status: 429, message: 'rate limit' }));
  assert.ok(!isModelGone({ status: 500, message: 'server error' }));
});
test('gpt-oss gets low reasoning and room for the answer; others untouched', () => {
  const base = { max_tokens: 350, temperature: 0.9 };
  const g = paramsFor('openai/gpt-oss-120b', base);
  assert.strictEqual(g.reasoning_effort, 'low');
  assert.ok(g.max_tokens >= 1024);
  const q = paramsFor('qwen/qwen3.6-27b', base);
  assert.strictEqual(q.max_tokens, 350);
  assert.strictEqual(q.reasoning_effort, undefined);
});
