const test = require('node:test');
const assert = require('node:assert');
const o = require('../llm_openai');

const TOOL = { type: 'function', function: { name: 'send_reply', description: 'reply', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } };
const okReply = (text) => ({ data: { output: [{ type: 'reasoning' }, { type: 'function_call', call_id: 'c1', name: 'send_reply', arguments: JSON.stringify({ message: text }) }] } });
const httpErr = (status, message) => Object.assign(new Error(message), { response: { status, data: { error: { message } } } });

test('chain: GPT-6.1 Sol first, then Sol, then Luna; OPENAI_MODEL leads without duplicates', () => {
  assert.deepStrictEqual(o.modelChain({}), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']);
  assert.deepStrictEqual(o.modelChain({ OPENAI_MODEL: 'gpt-6-astra' }), ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']);
  assert.strictEqual(o.modelChain({ OPENAI_MODEL: 'gpt-6-luna' }).filter((m) => m === 'gpt-6-luna').length, 1);
});

test('request is shaped for the Responses API (flat tools, instructions, forced function)', () => {
  const b = o.buildBody({ model: 'gpt-6.1-sol', history: [{ role: 'user', content: 'hey' }, { role: 'assistant', content: 'hi' }], sys: 'You are Ariana', tools: [TOOL], toolChoice: { type: 'function', function: { name: 'send_reply' } }, effort: 'low', maxOutputTokens: 2000, temperature: 0.92 });
  assert.strictEqual(b.instructions, 'You are Ariana');
  assert.deepStrictEqual(b.input, [{ role: 'user', content: 'hey' }, { role: 'assistant', content: 'hi' }]);
  assert.strictEqual(b.tools[0].name, 'send_reply');
  assert.strictEqual(b.tools[0].function, undefined);
  assert.deepStrictEqual(b.tool_choice, { type: 'function', name: 'send_reply' });
  assert.deepStrictEqual(b.reasoning, { effort: 'low' });
  assert.strictEqual(b.store, false);
});

test('image parts are converted for vision input', () => {
  const [m] = o.toInput([{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }]);
  assert.deepStrictEqual(m.content, [{ type: 'input_text', text: 'what is this' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }]);
});

test('response becomes the chat-style message the brain expects', () => {
  const m = o.fromResponse(okReply('hey you').data);
  assert.strictEqual(m.tool_calls[0].function.name, 'send_reply');
  assert.strictEqual(JSON.parse(m.tool_calls[0].function.arguments).message, 'hey you');
  const t = o.fromResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'plain' }] }] });
  assert.strictEqual(t.content, 'plain');
  assert.strictEqual(t.tool_calls, undefined);
});

test('refusals and empty output throw so the caller can fall back', () => {
  assert.throws(() => o.fromResponse({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), /refused/);
  assert.throws(() => o.fromResponse({ output: [], incomplete_details: { reason: 'max_output_tokens' } }), /max_output_tokens/);
});

test('missing model -> tries the next one', async () => {
  const seen = [];
  const post = async (url, body) => { seen.push(body.model); if (body.model === 'gpt-6.1-sol') throw httpErr(404, 'The model `gpt-6.1-sol` does not exist or you do not have access to it.'); return okReply('ok'); };
  const m = await o.complete({ apiKey: 'k', history: [{ role: 'user', content: 'x' }], sys: 's', tools: [TOOL], post });
  assert.deepStrictEqual(seen, ['gpt-6.1-sol', 'gpt-6-sol']);
  assert.ok(m.tool_calls);
});

test('a rejected parameter is dropped and the request retried on the same model', async () => {
  const calls = [];
  const post = async (url, body) => {
    calls.push(JSON.parse(JSON.stringify(body)));
    if ('temperature' in body) throw httpErr(400, "Unsupported parameter: 'temperature' is not supported with this model.");
    return okReply('ok');
  };
  await o.complete({ apiKey: 'k', history: [], sys: 's', tools: [TOOL], temperature: 0.9, post });
  assert.strictEqual(calls.length, 2);
  assert.ok(!('temperature' in calls[1]));
  assert.strictEqual(calls[1].model, calls[0].model);
});

test('forced tool_choice falls back to "required" if the model objects', async () => {
  let n = 0;
  const post = async (url, body) => { n++; if (typeof body.tool_choice === 'object') throw httpErr(400, 'tool_choice with a specific function is not supported with reasoning'); return okReply('ok'); };
  await o.complete({ apiKey: 'k', history: [], sys: 's', tools: [TOOL], toolChoice: { type: 'function', function: { name: 'send_reply' } }, post });
  assert.strictEqual(n, 2);
});

test('auth, rate-limit and server errors are NOT retried across models', async () => {
  for (const status of [401, 429, 500]) {
    let n = 0;
    const post = async () => { n++; throw httpErr(status, 'nope'); };
    await assert.rejects(o.complete({ apiKey: 'k', history: [], sys: 's', post }), (e) => e.status === status);
    assert.strictEqual(n, 1);
  }
});

test('probe lists only GPT-6 models', async () => {
  const get = async () => ({ data: { data: [{ id: 'gpt-4o' }, { id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }] } });
  assert.deepStrictEqual(await o.probe('k', get), { ok: true, models: ['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol'] });
  const bad = async () => { throw httpErr(401, 'Incorrect API key'); };
  const r = await o.probe('k', bad);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /401/);
});
