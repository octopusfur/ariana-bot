/**
 * Ariana's durable-memory review store.
 *
 * Conversation extraction is intentionally separate from active memory. A
 * candidate is stored first, screened, and only an approved item is exposed
 * through the memory retrieval context. Supabase is the authoritative store
 * when configured; the private local registry is a development fallback.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const REGISTRY_FILE = path.join(__dirname, 'brain', 'memory_registry.json');
let registryFile = REGISTRY_FILE;
const DEFAULT_STATE = () => ({ schema_version: 1, items: [], history: [] });
const CATEGORIES = ['fact', 'preference', 'relationship', 'experience', 'skill', 'behavioral_lesson', 'other'];
const STATUSES = ['candidate', 'approved', 'rejected', 'archived'];

let supabase = null;
let state = DEFAULT_STATE();
let loaded = false;
let backend = 'local';
let brainCache = null;
let writeChain = Promise.resolve();

function now() { return new Date().toISOString(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function id() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`; }
function normalise(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase(); }
function safeCategory(value) { return CATEGORIES.includes(value) ? value : 'other'; }
function safeStatus(value) { return STATUSES.includes(value) ? value : null; }

// Never keep credentials in a memory item or its audit trail. This is a
// defence-in-depth redaction, not a promise that arbitrary input is safe.
function redactSecrets(value) {
  return String(value == null ? '' : value)
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(?:xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/(api[_ -]?key|access[_ -]?token|auth(?:entication)?[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]');
}

function scanContent(original) {
  const raw = String(original == null ? '' : original);
  const text = raw.toLowerCase();
  const reasons = [];
  const critical = [];
  const add = (reason, level = 'warning') => {
    reasons.push(reason);
    if (level === 'critical') critical.push(reason);
  };

  if (/(kill|hurt|attack|assault|threaten|beat|burn|poison|shoot|stab|abuse|harass|dox|swat)\b[\s\S]{0,80}\b(people|him|her|them|someone|anyone|you|they)/i.test(raw) ||
      /\b(how to|instructions? to|tell me how to)\b[\s\S]{0,80}\b(weapon|bomb|poison|hurt|harm|attack|kill)/i.test(raw)) {
    add('May encourage violence, abuse, harassment, or dangerous action.', 'critical');
  }
  if (/(ignore|bypass|override|disregard)\b[\s\S]{0,80}\b(previous|system|developer|creator|safety|rules?|instructions?)/i.test(raw) ||
      /\b(prompt injection|jailbreak|ignore your rules)\b/i.test(raw)) {
    add('Looks like an instruction to bypass safety or creator-defined rules.', 'critical');
  }
  if (/\b(manipulat|coerc|exploit|blackmail|extort|force|pressure)\w*\b/i.test(text) &&
      /\b(people|him|her|them|someone|partner|user|victim)\b/i.test(text)) {
    add('May encourage manipulation, coercion, exploitation, or dangerous control.', 'critical');
  }
  if (/(change|rewrite|remove|forget|replace|become|adopt)\b[\s\S]{0,80}\b(your identity|core identity|creator|boundaries|rules|configuration|safety)/i.test(raw) ||
      /\b(you are not ariana|you are now|your creator says|creator configuration)\b/i.test(raw)) {
    add('Attempts to change Ariana’s core identity, creator configuration, or boundaries.', 'critical');
  }
  if (/(api[_ -]?key|access[_ -]?token|auth(?:entication)?[_ -]?token|password|secret|private key|bearer\s+)/i.test(raw) ||
      /\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b|\bAIza[0-9A-Za-z_-]{20,}\b/i.test(raw)) {
    add('Contains a credential or secret; it is redacted and must not become ordinary memory.', 'critical');
  }
  // Only flag concrete accusations presented as facts. Personal experiences or
  // disagreements without an accusation remain learnable.
  if (/\b(?:is|was|has been)\s+(?:a|an)?\s*(?:criminal|scammer|fraud|abuser|violent|dangerous|liar|cheater|thief)\b/i.test(raw) ||
      /\b(?:he|she|they)\s+(?:stole|robbed|assaulted|abused|scammed)\b/i.test(raw)) {
    add('Contains an unverified claim about another person; review before treating it as fact.', 'warning');
  }

  return { flagged: reasons.length > 0, reasons, critical: critical.length > 0 };
}

function categoryForKey(key) {
  const k = String(key || '').toLowerCase();
  if (/name|age|birthday|birth|location|city|job|work|fact|status/.test(k)) return k.includes('status') ? 'relationship' : 'fact';
  if (/like|love|prefer|dislike|hobby|interest|food|music|travel/.test(k)) return 'preference';
  if (/relationship|partner|friend|family/.test(k)) return 'relationship';
  if (/learn|lesson|habit|behavior/.test(k)) return 'behavioral_lesson';
  if (/skill|know|can_/.test(k)) return 'skill';
  return 'other';
}

function readableContent(key, value) {
  const k = String(key || '').replace(/[_-]+/g, ' ').trim();
  const v = redactSecrets(value);
  if (!k) return v;
  return `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`;
}

function fingerprintFor({ userId, key, value, content }) {
  const basis = [normalise(userId), normalise(key), normalise(value || content)].join('|');
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function auditSafe(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactSecrets(value).slice(0, 10000);
  if (Array.isArray(value)) return value.map(auditSafe).slice(0, 100);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) out[key] = auditSafe(item);
    return out;
  }
  return value;
}

function publicItem(item) {
  if (!item) return null;
  return {
    ...clone(item),
    value: typeof item.value === 'string' ? redactSecrets(item.value) : auditSafe(item.value),
    content: redactSecrets(item.content),
    source: auditSafe(item.source),
    flag_reasons: Array.isArray(item.flag_reasons) ? item.flag_reasons.slice() : [],
    used_in_retrieval: item.status === 'approved' && !item.quarantine,
  };
}

function localEnsure() {
  if (!state || typeof state !== 'object') state = DEFAULT_STATE();
  if (!Array.isArray(state.items)) state.items = [];
  if (!Array.isArray(state.history)) state.history = [];
}

async function loadLocal() {
  try {
    state = JSON.parse(await fsp.readFile(registryFile, 'utf8'));
  } catch (_) {
    state = DEFAULT_STATE();
  }
  localEnsure();
  backend = 'local';
  loaded = true;
}

async function writeLocal() {
  localEnsure();
  await (writeChain = writeChain.then(async () => {
    await fsp.mkdir(path.dirname(registryFile), { recursive: true });
    const tmp = `${registryFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, registryFile);
  }));
}

function tableMissing(error) {
  return /does not exist|could not find the table|relation .* does not exist|schema cache/i.test(String(error?.message || error?.hint || ''));
}

async function loadSupabase() {
  const { data, error } = await supabase.from('ariana_memory_items').select('*').order('created_at', { ascending: true });
  if (error) {
    if (tableMissing(error)) return false;
    throw error;
  }
  const history = await supabase.from('ariana_memory_history').select('*').order('created_at', { ascending: true });
  if (history.error && !tableMissing(history.error)) throw history.error;
  state = { schema_version: 1, items: data || [], history: history.data || [] };
  backend = 'supabase';
  loaded = true;
  return true;
}

async function configure({ client = null, cache = null, file = registryFile } = {}) {
  registryFile = file || REGISTRY_FILE;
  supabase = client || null;
  brainCache = cache || brainCache;
  loaded = false;
  if (supabase) {
    try {
      if (await loadSupabase()) return backend;
      console.warn('[memory] Supabase memory tables are not available; using private local registry until schema.sql is applied.');
    } catch (error) {
      console.warn('[memory] Supabase load failed; using private local registry:', error.message);
    }
  }
  await loadLocal();
  return backend;
}

async function ensureLoaded() {
  if (!loaded) await configure({ client: supabase, cache: brainCache, file: registryFile });
}

async function refresh() {
  loaded = false;
  return ensureLoaded();
}

async function persistItem(item, historyEntry, { remove = false } = {}) {
  if (backend === 'supabase' && supabase) {
    if (remove) {
      const { error } = await supabase.from('ariana_memory_items').delete().eq('id', item.id);
      if (error) throw error;
    } else {
      const row = { ...item, source: item.source || {}, flag_reasons: item.flag_reasons || [] };
      const { error } = await supabase.from('ariana_memory_items').upsert(row, { onConflict: 'id' });
      if (error) throw error;
    }
    if (historyEntry) {
      const { error } = await supabase.from('ariana_memory_history').insert(historyEntry);
      if (error) throw error;
    }
  }

  // Keep the process cache in step with the authoritative write. This matters
  // immediately after approval/edit/delete, before the next Supabase refresh.
  if (remove) state.items = state.items.filter(existing => existing.id !== item.id);
  else {
    const index = state.items.findIndex(existing => existing.id === item.id);
    if (index === -1) state.items.push(item); else state.items[index] = item;
  }
  if (historyEntry) state.history.push(historyEntry);
  if (backend !== 'supabase' || !supabase) await writeLocal();
}

function historyEntry(itemId, event, previous, next, source = 'manual', actor = 'creator') {
  return {
    id: id(), item_id: itemId, event, previous: auditSafe(previous), next: auditSafe(next),
    source, actor, created_at: now(),
  };
}

function findItem(itemId) {
  return state.items.find(item => item.id === itemId) || null;
}

async function createCandidate({ userId, key, value, content, category, confidence = null, source = {}, sourceType = 'automatic' }) {
  await ensureLoaded();
  const cleanValue = redactSecrets(value == null ? content : value).slice(0, 4000);
  const cleanContent = redactSecrets(content || readableContent(key, cleanValue)).slice(0, 4000);
  if (!cleanContent) return { ok: false, skipped: true, reason: 'empty' };
  const fingerprint = fingerprintFor({ userId, key, value: cleanValue, content: cleanContent });
  const existing = state.items.find(item => item.fingerprint === fingerprint && item.status !== 'archived');
  if (existing) return { ok: true, duplicate: true, item: publicItem(existing) };
  const scan = scanContent(`${cleanContent}\n${cleanValue}`);
  const item = {
    id: id(), user_id: String(userId || 'unknown'), memory_key: String(key || '').slice(0, 160),
    content: cleanContent, value: cleanValue, category: safeCategory(category || categoryForKey(key)),
    confidence: confidence == null || confidence === '' ? null : (Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : null),
    status: 'candidate', source: auditSafe(source), source_type: sourceType === 'manual' ? 'manual' : 'automatic',
    flagged: scan.flagged, quarantine: scan.flagged, flag_reasons: scan.reasons,
    fingerprint, learned_at: now(), created_at: now(), updated_at: now(),
    last_retrieved_at: null,
  };
  await persistItem(item, historyEntry(item.id, 'candidate_created', null, item, item.source_type, item.source_type === 'automatic' ? 'ariana' : 'creator'));
  return { ok: true, item: publicItem(item) };
}

async function createCandidatesFromObject({ userId, learned, source = {}, sourceType = 'automatic' }) {
  const results = [];
  for (const [key, value] of Object.entries(learned || {})) {
    if (key.startsWith('_') || value == null || value === '') continue;
    results.push(await createCandidate({ userId, key, value, source, sourceType }));
  }
  return results;
}

async function updateCandidate(itemId, patch = {}, actor = 'creator') {
  await ensureLoaded();
  const item = findItem(itemId);
  if (!item) return { ok: false, error: 'Learning not found.' };
  if (item.status !== 'candidate') return { ok: false, error: 'Only unreviewed learnings can be edited here.' };
  const nextContent = patch.content == null ? item.content : redactSecrets(String(patch.content)).trim().slice(0, 4000);
  if (!nextContent) return { ok: false, error: 'Memory content cannot be empty.' };
  const scan = scanContent(nextContent);
  const next = { ...item, content: nextContent, category: safeCategory(patch.category || item.category), flagged: scan.flagged, quarantine: scan.flagged, flag_reasons: scan.reasons, updated_at: now() };
  if (patch.confidence !== undefined) next.confidence = patch.confidence == null || patch.confidence === '' ? null : (Number.isFinite(Number(patch.confidence)) ? Math.max(0, Math.min(1, Number(patch.confidence))) : null);
  await persistItem(next, historyEntry(item.id, 'edited', item, next, 'manual', actor));
  return { ok: true, item: publicItem(next) };
}

async function approve(itemId, patch = {}, actor = 'creator') {
  await ensureLoaded();
  const item = findItem(itemId);
  if (!item) return { ok: false, error: 'Learning not found.' };
  if (item.status !== 'candidate') return { ok: false, error: 'This learning is no longer awaiting review.' };
  let current = item;
  if (patch.content !== undefined || patch.category !== undefined) {
    const edited = await updateCandidate(itemId, patch, actor);
    if (!edited.ok) return edited;
    current = findItem(itemId);
  }
  const scan = scanContent(current.content);
  if (scan.critical) return { ok: false, error: 'This learning is still quarantined: ' + scan.reasons.join(' ') + '.', flagged: true, reasons: scan.reasons };
  if (scan.flagged && !patch.allow_flagged) return { ok: false, error: 'Review the warning before approving this learning.', flagged: true, reasons: scan.reasons };
  const next = { ...current, status: 'approved', flagged: scan.flagged, quarantine: false, flag_reasons: scan.reasons, updated_at: now() };
  await persistItem(next, historyEntry(itemId, 'approved', current, next, 'manual', actor));
  return { ok: true, item: publicItem(next) };
}

async function setStatus(itemId, status, actor = 'creator') {
  await ensureLoaded();
  const item = findItem(itemId);
  if (!item) return { ok: false, error: 'Memory not found.' };
  if (!['rejected', 'archived'].includes(status)) return { ok: false, error: 'Unsupported status change.' };
  const next = { ...item, status, quarantine: status !== 'approved', updated_at: now() };
  await persistItem(next, historyEntry(itemId, status, item, next, 'manual', actor));
  return { ok: true, item: publicItem(next) };
}

async function remove(itemId, actor = 'creator') {
  await ensureLoaded();
  const item = findItem(itemId);
  if (!item) return { ok: false, error: 'Memory not found.' };
  const audit = historyEntry(itemId, 'deleted', item, null, 'manual', actor);
  await persistItem(item, audit, { remove: true });
  return { ok: true, deleted: itemId };
}

async function editApproved(itemId, patch = {}, actor = 'creator') {
  await ensureLoaded();
  const item = findItem(itemId);
  if (!item) return { ok: false, error: 'Memory not found.' };
  if (item.status !== 'approved') return { ok: false, error: 'Only active approved memories can be edited here.' };
  const content = patch.content == null ? item.content : redactSecrets(String(patch.content)).trim().slice(0, 4000);
  if (!content) return { ok: false, error: 'Memory content cannot be empty.' };
  const scan = scanContent(content);
  if (scan.critical) return { ok: false, error: 'This change would quarantine the memory: ' + scan.reasons.join(' '), flagged: true, reasons: scan.reasons };
  const next = { ...item, content, category: safeCategory(patch.category || item.category), flagged: scan.flagged, quarantine: scan.flagged, flag_reasons: scan.reasons, updated_at: now() };
  await persistItem(next, historyEntry(itemId, 'edited', item, next, 'manual', actor));
  return { ok: true, item: publicItem(next) };
}

async function list({ status = null, search = '', category = null, sort = 'newest' } = {}) {
  await refresh();
  let items = state.items.slice();
  if (status) items = items.filter(item => item.status === status);
  if (category && category !== 'all') items = items.filter(item => item.category === category);
  const needle = normalise(search);
  if (needle) items = items.filter(item => normalise(`${item.content} ${item.value} ${item.memory_key} ${JSON.stringify(item.source)}`).includes(needle));
  items.sort((a, b) => {
    if (sort === 'oldest') return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    if (sort === 'category') return String(a.category).localeCompare(String(b.category)) || Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0);
    return Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0);
  });
  return items.map(publicItem);
}

async function overview() {
  await refresh();
  const counts = { total: state.items.length, candidates: 0, approved: 0, rejected: 0, archived: 0, flagged: 0 };
  for (const item of state.items) {
    if (item.status === 'candidate') counts.candidates++;
    else if (item.status === 'approved') counts.approved++;
    else if (item.status === 'rejected') counts.rejected++;
    else if (item.status === 'archived') counts.archived++;
    if (item.flagged && item.status === 'candidate') counts.flagged++;
  }
  const changes = state.history.slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const last = changes.find(entry => ['candidate_created', 'approved', 'edited', 'rejected', 'archived', 'deleted'].includes(entry.event));
  return { ...counts, last_update: last ? last.created_at : null, last_update_event: last ? last.event : null, backend, categories: CATEGORIES };
}

async function history({ itemId = null, limit = 100 } = {}) {
  await refresh();
  const rows = state.history.filter(row => !itemId || row.item_id === itemId).slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)).slice(0, limit);
  return rows.map(row => auditSafe(row));
}

async function restoreHistory(historyId, actor = 'creator') {
  await ensureLoaded();
  const entry = state.history.find(row => row.id === historyId);
  if (!entry || !entry.previous) return { ok: false, error: 'That history entry cannot be restored.' };
  const previous = clone(entry.previous);
  const current = findItem(previous.id);
  const restored = { ...previous, status: safeStatus(previous.status) || 'approved', updated_at: now() };
  await persistItem(restored, historyEntry(restored.id, 'restored', current, restored, 'manual', actor));
  return { ok: true, item: publicItem(restored) };
}

function getApprovedContextSync(userId) {
  if (!loaded) return '';
  const wanted = String(userId || '');
  return state.items.filter(item => item.status === 'approved' && !item.quarantine && (!item.user_id || item.user_id === wanted || item.user_id === 'global' || item.user_id === 'owner_live_talk'))
    .slice(-50)
    .map(item => item.content)
    .join('\n');
}

function markRetrieved(userId) {
  // Retrieval is deliberately cache-local and best-effort. It never promotes an
  // item and does not write the content into a second memory file.
  if (!loaded) return;
  const stamp = now();
  for (const item of state.items) if (item.status === 'approved' && (item.user_id === userId || item.user_id === 'global')) item.last_retrieved_at = stamp;
}

async function migrateLegacyLearned(legacy) {
  await ensureLoaded();
  const source = legacy && typeof legacy === 'object' ? legacy : {};
  for (const [contactKey, values] of Object.entries(source)) {
    if (contactKey.startsWith('_') || !values || typeof values !== 'object') continue;
    const userId = contactKey.startsWith('contact_') ? contactKey.slice(8) : contactKey;
    const learned = Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith('_')));
    const results = await createCandidatesFromObject({ userId, learned, source: { type: 'legacy_brain', reference: contactKey }, sourceType: 'automatic' });
    // These records were already active in the legacy brain before the review
    // gate existed. Preserve safe legacy behaviour while quarantining anything
    // that fails the same safety scan.
    for (const result of results) {
      const item = result.item;
      if (item && item.status === 'candidate' && !item.flagged) await approve(item.id, { allow_flagged: true }, 'migration');
    }
  }
}

function getBackend() { return backend; }
function getCategories() { return CATEGORIES.slice(); }

module.exports = {
  configure, refresh, getBackend, getCategories, overview, list, history, restoreHistory,
  createCandidate, createCandidatesFromObject, updateCandidate, approve, setStatus, remove,
  editApproved, getApprovedContextSync, markRetrieved, migrateLegacyLearned,
  scanContent, redactSecrets,
};
