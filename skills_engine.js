// skills_engine.js
// ─────────────────────────────────────────────────────────────────────────────
// Ported concept (not code) from Nous Research's Hermes Agent: an agent that
// writes a reusable "skill document" after finishing something novel and
// successful, retrieves matching skills on similar future situations, and
// runs a periodic curator pass that prunes skills that never got reused.
//
// Mapped onto Ariana's actual architecture, since she has no formal
// tool-execution/task loop (unlike a coding agent, there's no "tests passed")
// — "success" here means: the user's very next message reads as clear
// positive/grateful feedback right after a substantive prior exchange. That's
// a real, cheap, already-observable signal, not an invented one. It will
// under-catch some real wins and over-catch some polite "thanks" — that's
// what the curator pass (pruneUnusedCandidates) is for: candidates that never
// get reused just age out instead of cluttering the library forever.
//
// Storage is Supabase (not a local JSON file like the sibling engines) on
// purpose: this is shared, cross-conversation, cross-redeploy data — a skill
// learned from one user should be usable in a totally different chat later,
// and it needs to survive a redeploy wiping local disk.
//
// SQL to run once in the Supabase SQL editor before this does anything:
//
//   create table ariana_skills (
//     id           bigint generated always as identity primary key,
//     user_id      text,
//     platform     text,
//     trigger_text text not null,   -- what the person needed/asked
//     procedure    text not null,   -- how Ariana handled it (her prior reply)
//     status       text not null default 'candidate', -- candidate | confirmed
//     uses         int  not null default 1,
//     created_at   timestamptz not null default now(),
//     last_used_at timestamptz not null default now()
//   );
//   create index ariana_skills_trigger_idx on ariana_skills
//     using gin (to_tsvector('english', trigger_text));
//
// ─────────────────────────────────────────────────────────────────────────────

const memoryManager = require('./memory_manager');

// Lifecycle: candidate -> proposed (reused enough times) -> confirmed (creator approved) -> retired.
// Only 'confirmed' skills ever reach a prompt. A skill is text guidance; it cannot call tools
// or widen any permission.
const STATUSES = ['candidate', 'proposed', 'confirmed', 'retired'];

let supabase = null;
function _setClientForTest(c) { supabase = c; }
function client() {
  if (supabase) return supabase;
  const { createClient } = require('@supabase/supabase-js');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.SUPABASE_SERVICE_KEY
           || process.env.SUPABASE_KEY;
  if (!process.env.SUPABASE_URL || !key) return null;
  supabase = createClient(process.env.SUPABASE_URL, key);
  return supabase;
}

// Confidence gate for promoting a candidate to a trusted, freely-reused skill.
// Mirrors Hermes' confidence>0.7 gate, simplified to a plain reuse count since
// we don't have a real confidence model here.
const PROMOTE_AFTER_USES = 3;
// Curator prune window — candidates that are still sitting at their original
// single use after this many days clearly never got reused; drop them.
const PRUNE_CANDIDATE_AFTER_DAYS = 14;

// Crude but real: no LLM call, no invented signal — just what a person
// actually types right after something that worked.
const POSITIVE_COMPLETION = /\b(thank(s| you)|omg (yes|thank)|that (worked|helped|fixed it)|exactly( what)? i needed|you'?re (a genius|amazing|the best)|finally|perfect,? (thanks|ty)|appreciate (it|you))\b/i;

function looksLikeCompletion(message) {
  return !!message && POSITIVE_COMPLETION.test(message);
}

// history: the small tail of {role, content} the caller already has handy
// (e.g. convo.messages.slice(-4) in index.js) — we just need the most recent
// user ask + Ariana's reply to it, not the whole conversation.
async function maybeLearnSkill(userId, message, history = [], platform = null) {
  const db = client();
  if (!db || !looksLikeCompletion(message)) return;

  // Find the last assistant reply and the user turn it answered.
  const lastAssistantIdx = [...history].reverse().findIndex(m => m.role === 'assistant');
  if (lastAssistantIdx === -1) return;
  const idx = history.length - 1 - lastAssistantIdx;
  const priorReply = history[idx];
  const priorAsk = history.slice(0, idx).reverse().find(m => m.role === 'user');
  if (!priorAsk || !priorReply) return;

  // Skip trivial exchanges — a skill worth saving involved actual substance,
  // not "hey" -> "hey babe". This is the cheapest possible novelty filter.
  if (priorAsk.content.length < 25 && priorReply.content.length < 60) return;

  // Untrusted input: never keep credentials, and never keep text that looks like an
  // attempt to override rules or identity. Nothing here is stored in a quarantined form.
  const scan = memoryManager.scanContent(`${priorAsk.content}\n${priorReply.content}`);
  if (scan.flagged) { console.warn('[skills] exchange rejected by safety scan; not saved'); return; }
  const trigger = memoryManager.redactSecrets(priorAsk.content).slice(0, 500);
  const procedure = memoryManager.redactSecrets(priorReply.content).slice(0, 1000);

  try {
    // If a near-identical trigger already exists for this exact ask, treat
    // this positive follow-up as reuse instead of minting a duplicate.
    const existing = await findRelevantSkills(priorAsk.content, 1);
    if (existing.length && existing[0].trigger_text.slice(0, 40) === priorAsk.content.slice(0, 40)) {
      await recordSkillReuse(existing[0].id);
      return;
    }

    await db.from('ariana_skills').insert({
      user_id: userId,
      platform,
      trigger_text: trigger,
      procedure,
      status: 'candidate',
      uses: 1
    });
    console.log(`[skills] candidate saved for ${userId}`);
  } catch (e) {
    console.warn('[skills] failed to save candidate:', e.message);
  }
}

// Simple full-text search — Postgres `to_tsvector`/`plainto_tsquery` via the
// GIN index in the SQL above. Falls back to `ilike` if textSearch errors
// (e.g. the index wasn't created), so this never hard-fails the reply path.
async function findRelevantSkills(query, limit = 2) {
  const db = client();
  if (!db || !query) return [];
  try {
    const { data, error } = await db.from('ariana_skills')
      .select('*')
      .eq('status', 'confirmed')
      .textSearch('trigger_text', query.split(/\s+/).slice(0, 8).join(' & '), { type: 'plain' })
      .order('status', { ascending: false }) // confirmed skills first
      .order('uses', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (e) {
    try {
      const words = query.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
      if (!words.length) return [];
      const { data } = await db.from('ariana_skills')
        .select('*')
        .eq('status', 'confirmed')
        .or(words.map(w => `trigger_text.ilike.%${w}%`).join(','))
        .limit(limit);
      return data || [];
    } catch (e2) {
      console.warn('[skills] retrieval fully failed:', e2.message);
      return [];
    }
  }
}

async function recordSkillReuse(skillId) {
  const db = client();
  if (!db) return;
  try {
    const { data } = await db.from('ariana_skills').select('uses,status').eq('id', skillId).single();
    if (!data) return;
    const uses = (data.uses || 1) + 1;
    // Reuse can only propose a skill; the creator decides whether it becomes active.
    const status = (uses >= PROMOTE_AFTER_USES && data.status === 'candidate') ? 'proposed' : data.status;
    await db.from('ariana_skills').update({ uses, status, last_used_at: new Date().toISOString() }).eq('id', skillId);
  } catch (e) {
    console.warn('[skills] failed to record reuse:', e.message);
  }
}

// The "curator" — call on a daily setInterval alongside the app's other
// periodic jobs. Grading/consolidating (Hermes' fuller version) is future
// work; this ships the prune half, which is the part that keeps the library
// from turning into noise.
async function pruneUnusedCandidates() {
  const db = client();
  if (!db) return;
  const cutoff = new Date(Date.now() - PRUNE_CANDIDATE_AFTER_DAYS * 86400000).toISOString();
  try {
    const { data, error } = await db.from('ariana_skills')
      .update({ status: 'retired' })
      .eq('status', 'candidate')
      .eq('uses', 1)
      .lt('created_at', cutoff)
      .select('id');
    if (error) throw error;
    if (data && data.length) console.log(`[skills] curator retired ${data.length} unused candidate(s)`);
  } catch (e) {
    console.warn('[skills] curator pass failed:', e.message);
  }
}

// Creator review surface.
async function listSkills({ status = null, limit = 200 } = {}) {
  const db = client();
  if (!db) return { ok: false, error: 'Supabase is not configured.', skills: [] };
  let q = db.from('ariana_skills').select('*').order('last_used_at', { ascending: false }).limit(limit);
  if (status && STATUSES.includes(status)) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message, skills: [] };
  return { ok: true, skills: data || [] };
}

async function setSkillStatus(id, status) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  const db = client();
  if (!db) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await db.from('ariana_skills').update({ status }).eq('id', id).select('*');
  if (error) return { ok: false, error: error.message };
  if (!data || !data.length) return { ok: false, error: 'Skill not found.' };
  return { ok: true, skill: data[0] };
}

module.exports = {
  listSkills, setSkillStatus, STATUSES, _setClientForTest,
  maybeLearnSkill,
  findRelevantSkills,
  recordSkillReuse,
  pruneUnusedCandidates,
  looksLikeCompletion // exported for testing
};
