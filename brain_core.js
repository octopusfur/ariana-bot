/**
 * Pure helpers for Ariana's memory layers (no I/O, no database).
 *
 * The layer model follows brAIn / ZenBrain: working, short-term, episodic,
 * semantic, procedural, core and cross-context. The retention curve is an
 * Ebbinghaus-style forgetting curve ported natively, because
 * @zensation/algorithms needs Node >= 22 while package.json still declares 20.x.
 *
 * Forgetting here is only a reduction in prominence. Nothing is deleted.
 */
'use strict';

const LAYERS = ['working', 'short_term', 'episodic', 'semantic', 'procedural', 'core', 'cross_context'];

const CATEGORY_LAYER = {
  fact: 'semantic', preference: 'semantic', relationship: 'semantic',
  experience: 'episodic', skill: 'procedural', behavioral_lesson: 'procedural', other: 'short_term',
};

const CATEGORY_IMPORTANCE = {
  relationship: 0.8, preference: 0.7, fact: 0.7, behavioral_lesson: 0.7,
  skill: 0.6, experience: 0.5, other: 0.3,
};

const clamp01 = n => Math.max(0, Math.min(1, n));

function layerFor(category, userId) {
  if (String(userId || '') === 'global') return 'cross_context';
  return CATEGORY_LAYER[category] || 'short_term';
}

function importanceFor(category, confidence) {
  const base = CATEGORY_IMPORTANCE[category] ?? 0.3;
  const known = confidence !== null && confidence !== undefined && confidence !== '' && Number.isFinite(Number(confidence));
  return clamp01(base * 0.8 + (known ? Number(confidence) : 0.5) * 0.2);
}

function tokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
}

function similarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

// Days until recall probability falls to ~37%. Grows with importance and with every use.
function stabilityDays(importance, accessCount) {
  const s = 30 * (0.5 + clamp01(importance)) * (1 + 0.5 * Math.max(0, accessCount || 0));
  return Math.min(365, s);
}

function retention({ importance, accessCount = 0, lastTouchedMs, nowMs = Date.now() }) {
  const ageDays = Math.max(0, (nowMs - lastTouchedMs) / 86400000);
  return Math.exp(-ageDays / stabilityDays(importance, accessCount));
}

// Protected from dormancy: the core layer, anything important, and anything the creator pinned.
const DORMANT_BELOW = 0.15;
const PROTECTED_IMPORTANCE = 0.6;

function shouldGoDormant({ layer, importance, pinned, retentionValue }) {
  if (pinned || layer === 'core') return false;
  if (importance >= PROTECTED_IMPORTANCE) return false;
  return retentionValue < DORMANT_BELOW;
}

module.exports = { LAYERS, layerFor, importanceFor, similarity, stabilityDays, retention, shouldGoDormant, DORMANT_BELOW, PROTECTED_IMPORTANCE };
