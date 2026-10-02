'use strict';
/**
 * Nigerian language detection for Ariana — Naija Pidgin ('pcm') and Yoruba ('yo').
 *
 * Used for two things:
 *   1. CHAT  — if someone writes Pidgin (or Yoruba) she answers in kind.
 *   2. VOICE — the language of her reply picks the TTS engine (WazobiaVoice for pcm/yo).
 *
 * Detection is weighted, not a bare word count: the CURRENT message counts double,
 * recent user messages count once, and words that are also ordinary English or Spanish
 * ("make", "fit", "una") are deliberately weak so normal chat never flips to Pidgin.
 * Returns 'pcm', 'yo', or null (= not Nigerian-language; caller keeps its own logic).
 */

// [pattern, weight]. Patterns run on lowercased, diacritic-stripped text.
const PIDGIN = [
  [/\bwetin\b/g, 3], [/\babeg\b/g, 3], [/\bwahala\b/g, 3], [/\bshey\b/g, 3], [/\bjare\b/g, 3],
  [/\bpikin\b/g, 3], [/\bsharp sharp\b/g, 3], [/\bno dey\b/g, 3], [/\be don\b/g, 3], [/\bi wan\b|\bwe wan\b|\byou wan\b|\bu wan\b/g, 3],
  [/\boya\b/g, 2], [/\bdey\b/g, 2], [/\bwey\b/g, 2], [/\bsabi\b/g, 2], [/\boga\b/g, 2], [/\babi\b/g, 2],
  [/\bsef\b/g, 2], [/\bno be\b/g, 2], [/\bhow far\b/g, 2], [/\boyibo\b/g, 2], [/\bjapa\b/g, 2], [/\bna so\b/g, 2],
  [/\bna\b/g, 1], [/\bdem\b/g, 1], [/\bsha\b/g, 1], [/\bchop\b/g, 1], [/\bnaija\b/g, 1], [/\bwallahi\b/g, 1], [/\bkuku\b/g, 1],
  [/\bunu\b|\buna\b/g, 1],
];

const YORUBA = [
  [/\bbawo ni\b|\bbawo\b/g, 3], [/\be kaaro\b|\be kaasan\b|\be kaale\b|\bo dabo\b/g, 3], [/\bmo dupe\b|\bo seun\b|\be se\b/g, 3],
  [/\bomo mi\b|\bolufe mi\b|\bololufe\b/g, 3], [/\bmo nife re\b|\bmo ni ife re\b|\bmo fe\b/g, 3],
  [/\bjowo\b|\bejoo\b/g, 3], [/\bkini\b|\bnje\b/g, 2], [/\bpelu\b/g, 2], [/\bnko\b|\bnkan\b/g, 2],
  [/\bomo\b/g, 1], [/\bgan\b/g, 1], [/\bpupo\b/g, 2], [/\bdaadaa\b/g, 3], [/\bbaba mi\b|\biya mi\b/g, 2], [/\baye mi\b/g, 3],
];

const YORUBA_CHARS = /[ẹọṣ]/gi; // rarely typed by accident — strong signal on its own

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFC');
}
function strip(s) {
  // Drop tone marks but keep the dotted letters (ẹ ọ ṣ) so they can still be counted separately.
  return norm(s).normalize('NFD').replace(/[\u0300\u0301\u0304]/g, '').normalize('NFC');
}

function score(rules, text) {
  let total = 0;
  for (const [re, w] of rules) {
    const m = text.match(re);
    if (m) total += w * Math.min(m.length, 3); // cap per-pattern so one repeated word can't dominate
  }
  return total;
}

function scoreText(text) {
  const t = strip(text);
  const pcm = score(PIDGIN, t);
  const yoChars = (t.match(YORUBA_CHARS) || []).length;
  const yo = score(YORUBA, t) + Math.min(yoChars, 4) * 2;
  return { pcm, yo };
}

/**
 * @param {string}   message        the text to classify (user message, or Ariana's reply for voice)
 * @param {string[]} recentUserMsgs earlier user messages in this chat (oldest → newest), optional
 * @returns {'pcm'|'yo'|null}
 */
function detectNaijaLanguage(message, recentUserMsgs = []) {
  const cur = scoreText(message);
  const rec = { pcm: 0, yo: 0 };
  for (const m of (recentUserMsgs || []).slice(-4)) {
    const s = scoreText(m);
    rec.pcm += s.pcm; rec.yo += s.yo;
  }
  const pcmTotal = cur.pcm * 2 + rec.pcm;
  const yoTotal = cur.yo * 2 + rec.yo;

  // Yoruba needs clearer evidence, and wins only if it beats Pidgin (Yoruba chat is usually code-mixed with Pidgin).
  if (yoTotal >= 6 && cur.yo >= 2 && yoTotal > pcmTotal) return 'yo';
  // Pidgin: clear in this message, or a Pidgin chat where this message is short ("ok", "lol").
  if (cur.pcm >= 3 || (pcmTotal >= 5 && cur.pcm >= 1) || (rec.pcm >= 6 && cur.yo === 0)) return 'pcm';
  return null;
}

const INSTRUCTIONS = {
  pcm:
    '\n\nNAIJA PIDGIN MODE: This person is writing Nigerian Pidgin English. Reply in natural Nigerian Pidgin — ' +
    'the way a real person in Lagos types it ("I dey", "wetin dey happen", "abeg", "no wahala", "na so", "make we", "I don tire"). ' +
    'Keep it natural, not a caricature: do not stack slang in every sentence, do not explain or translate your Pidgin, ' +
    'and match their energy. If they go back to standard English, go back to English. ' +
    'Everything else about who you are and how you text stays exactly the same.',
  yo:
    '\n\nYORUBA MODE: This person is writing Yoruba (often mixed with Pidgin or English, which is normal). ' +
    'Reply in Yoruba, mixing in Nigerian English or Pidgin where real Yoruba speakers naturally do. ' +
    'Keep sentences simple and use only Yoruba you are sure of. Plain spelling without tone marks is fine; ' +
    'if you use tone marks, use them correctly — never guess them. Do not translate yourself unless they ask. ' +
    'If they switch to English or Pidgin, follow them. Everything else about who you are and how you text stays the same.',
};

function naijaInstruction(lang) {
  return INSTRUCTIONS[lang] || '';
}

module.exports = { detectNaijaLanguage, naijaInstruction, scoreText };
