/**
 * HARMES: a Hermes-Agent-style learning loop for Ariana (ported natively; the
 * upstream project is Python and keeps its data on local disk).
 *
 * It does not own a store. Every learning goes through memory_manager, so it
 * is scanned, deduplicated, quarantined if unsafe, and lands in Supabase (the
 * authoritative store) or, while Supabase is unreachable, in a local outbox
 * that is replayed automatically when it comes back.
 *
 * What it adds:
 *  - Periodic "nudges": deterministic cadence for when the extraction pass runs.
 *  - Bounded memory: a size budget for what is injected into a prompt.
 *  - Reflexion: explicit user feedback becomes a behavioral_lesson candidate.
 *    Lessons are never active until the creator approves them.
 *  - Outage recovery: periodic reconnect + replay of queued writes.
 *
 * It never edits system prompts, identity, boundaries or tool permissions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const memory = require('./memory_manager');

const NUDGE_EVERY = Math.max(1, parseInt(process.env.HARMES_NUDGE_EVERY || '4', 10) || 4);
const MEMORY_BUDGET = Math.max(500, parseInt(process.env.HARMES_MEMORY_BUDGET || '3000', 10) || 3000);
const RECONNECT_MS = Math.max(10000, parseInt(process.env.HARMES_RECONNECT_MS || '60000', 10) || 60000);
const MAX_TRACKED = 5000;
const CONSOLIDATE_EVERY_MS = 24 * 3600 * 1000;
const JOBS_FILE = path.join(__dirname, 'brain', 'harmes_jobs.json');

const turns = new Map();
let timer = null;

function shouldNudge(userId) {
  const key = String(userId || 'unknown');
  const count = (turns.get(key) || 0) + 1;
  if (turns.size >= MAX_TRACKED && !turns.has(key)) turns.delete(turns.keys().next().value);
  turns.set(key, count);
  return count % NUDGE_EVERY === 0;
}

const NEGATIVE = /\b(that('?s| was| is) (wrong|incorrect|not right|rude|weird|annoying|not what i (asked|meant))|you('re| are) wrong|don'?t (say|do|talk) (that|like that|like this)|stop (saying|doing|repeating)|not what i asked)\b/i;
const POSITIVE = /\b(that('?s| was) (perfect|great|exactly (it|right|what i wanted))|good answer|exactly what i (wanted|needed)|love (that|this) (answer|reply|response))\b/i;

function classifyFeedback(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 240) return null;
  if (NEGATIVE.test(t)) return 'negative';
  if (POSITIVE.test(t)) return 'positive';
  return null;
}

// Turns explicit feedback into a reviewable lesson. Returns null when the
// message is not feedback. The candidate goes through the normal safety scan.
async function captureFeedback({ userId, text, lastReply = '', platform = null }) {
  const kind = classifyFeedback(text);
  if (!kind) return null;
  const quoted = String(text).trim().slice(0, 200);
  const context = lastReply ? ` after the reply: "${String(lastReply).slice(0, 160)}"` : '';
  return memory.createCandidate({
    userId,
    key: `feedback_${kind}`,
    content: `${kind === 'negative' ? 'Negative' : 'Positive'} feedback received ("${quoted}")${context}`,
    category: 'behavioral_lesson',
    confidence: 0.5,
    source: { type: 'feedback', reference: String(userId || ''), platform },
    sourceType: 'automatic',
  });
}

function getContext(userId, maxChars = MEMORY_BUDGET) {
  return memory.getApprovedContextSync(userId, { maxChars });
}

// Restart-safe daily maintenance: the last run time is kept on disk, and the pass is
// idempotent, so a restart can at worst repeat it.
async function runConsolidationIfDue(force = false) {
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).last_consolidation || 0; } catch (_) { /* first run */ }
  if (!force && Date.now() - last < CONSOLIDATE_EVERY_MS) return null;
  const report = await memory.consolidate();
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ last_consolidation: Date.now(), last_report: report }));
  } catch (_) { /* best effort */ }
  return report;
}

function start() {
  if (timer) return timer;
  timer = setInterval(() => {
    memory.reconnect().then(result => {
      if (result && result.ok === false && result.reason && result.reason !== 'no client') {
        console.warn(`[harmes] Supabase still unavailable (${result.pending ?? 0} write(s) queued): ${result.reason}`);
      }
    }).catch(error => console.warn('[harmes] reconnect failed:', error.message));
    runConsolidationIfDue().catch(error => console.warn('[harmes] consolidation failed:', error.message));
  }, RECONNECT_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

function status() {
  return { ...memory.getStatus(), nudge_every: NUDGE_EVERY, memory_budget: MEMORY_BUDGET, reconnect_ms: RECONNECT_MS };
}

module.exports = { runConsolidationIfDue, shouldNudge, classifyFeedback, captureFeedback, getContext, start, stop, status, MEMORY_BUDGET };
