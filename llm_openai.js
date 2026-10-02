'use strict';
/**
 * OpenAI client for Ariana's brain — Responses API (GPT-6 family: Sol / Luna / Astra).
 * Presents the same shape the brain already expects from Chat Completions:
 *   { content, tool_calls: [{ id, function: { name, arguments } }] }
 *
 * Env: OPENAI_API_KEY, OPENAI_MODEL (default gpt-6.1-sol), OPENAI_REASONING (default "low").
 * If a model is missing/forbidden we try the next one in the chain; if a model rejects a request
 * parameter (temperature, reasoning, tool_choice...) we retry without it.
 */
const axios = require('axios');

const API = 'https://api.openai.com/v1';
const DEFAULT_MODELS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'];

function modelChain(env = process.env) {
  const first = String(env.OPENAI_MODEL || '').trim();
  return [...new Set([first, ...DEFAULT_MODELS].filter(Boolean))];
}

function partToInput(part, role) {
  if (typeof part === 'string') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part };
  if (part && part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' };
  if (part && part.type === 'image_url') return { type: 'input_image', image_url: (part.image_url && part.image_url.url) || part.image_url };
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text: String((part && part.text) || '') };
}

function toInput(history) {
  return (history || []).map((m) => {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'developer' : 'user';
    const content = Array.isArray(m.content) ? m.content.map((p) => partToInput(p, role)) : String(m.content == null ? '' : m.content);
    return { role, content };
  });
}

function toTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => (t && t.type === 'function' && t.function
    ? { type: 'function', name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }
    : t));
}

function toToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  if (tc.type === 'function' && tc.function) return { type: 'function', name: tc.function.name };
  return tc;
}

function buildBody({ model, history, sys, tools, toolChoice, effort, maxOutputTokens, temperature }) {
  const body = { model, instructions: sys, input: toInput(history), max_output_tokens: maxOutputTokens, store: false };
  const t = toTools(tools);
  if (t) {
    body.tools = t;
    const tc = toToolChoice(toolChoice);
    if (tc) body.tool_choice = tc;
  }
  if (effort) body.reasoning = { effort };
  if (temperature != null) body.temperature = temperature;
  return body;
}

function fromResponse(data) {
  if (!data || data.error) throw new Error('OpenAI error: ' + ((data && data.error && data.error.message) || 'empty response'));
  const out = Array.isArray(data.output) ? data.output : [];
  let text = '';
  const tool_calls = [];
  for (const item of out) {
    if (item.type === 'function_call') {
      tool_calls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
    } else if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') text += c.text || '';
        else if (c.type === 'refusal') throw new Error('model refused: ' + String(c.refusal || '').slice(0, 120));
      }
    }
  }
  if (!text && !tool_calls.length) {
    const why = data.incomplete_details && data.incomplete_details.reason;
    throw new Error('OpenAI returned no output' + (why ? ` (${why})` : ''));
  }
  const msg = { role: 'assistant', content: text || null };
  if (tool_calls.length) msg.tool_calls = tool_calls;
  return msg;
}

// Remove exactly the thing the API complained about; null = nothing we can fix.
function repairBody(body, msg) {
  const b = JSON.parse(JSON.stringify(body));
  const m = /Unsupported parameter: '([\w.]+)'/i.exec(msg);
  if (m) {
    const [a, c] = m[1].split('.');
    if (c) { if (b[a]) delete b[a][c]; } else delete b[a];
    return b;
  }
  if (/temperature/i.test(msg) && 'temperature' in b) { delete b.temperature; return b; }
  if (/tool_choice/i.test(msg) && b.tool_choice && typeof b.tool_choice === 'object') { b.tool_choice = 'required'; return b; }
  if (/reasoning/i.test(msg) && b.reasoning) { delete b.reasoning; return b; }
  return null;
}

function apiError(e) {
  const status = e.response && e.response.status;
  const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
  const err = new Error(`OpenAI ${status || 'network'}: ${msg}`);
  err.status = status;
  err.apiMessage = msg;
  return err;
}

async function complete(opts) {
  const {
    apiKey, history, sys, tools, toolChoice,
    effort = 'low', maxOutputTokens = 2000, temperature,
    models = modelChain(), post = (url, body, cfg) => axios.post(url, body, cfg),
  } = opts;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  let lastErr;
  for (const model of models) {
    let body = buildBody({ model, history, sys, tools, toolChoice, effort, maxOutputTokens, temperature });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await post(`${API}/responses`, body, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 90000 });
        return fromResponse(res.data);
      } catch (e) {
        if (!e.response) { if (/^(model refused|OpenAI returned no output|OpenAI error)/.test(e.message)) throw e; throw apiError(e); }
        const err = apiError(e);
        if (err.status === 404 || /model_not_found|does not exist|do not have access/i.test(err.apiMessage)) { lastErr = err; break; }
        if (err.status === 400) {
          const fixed = repairBody(body, err.apiMessage);
          if (fixed) { body = fixed; continue; }
        }
        throw err;
      }
    }
  }
  throw lastErr || new Error('no OpenAI model available');
}

// Boot-time check: which GPT-6 models can this key actually use?
async function probe(apiKey, get = (url, cfg) => axios.get(url, cfg)) {
  try {
    const res = await get(`${API}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 20000 });
    const ids = ((res.data && res.data.data) || []).map((m) => m.id).filter((id) => /^gpt-6/.test(id)).sort();
    return { ok: true, models: ids };
  } catch (e) {
    const err = apiError(e);
    return { ok: false, error: err.message };
  }
}

module.exports = { modelChain, toInput, toTools, toToolChoice, buildBody, fromResponse, repairBody, complete, probe };
