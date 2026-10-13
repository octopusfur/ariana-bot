"use strict";
/**
 * media.js — turns incoming WhatsApp media into something Luna can actually use.
 *   image / static sticker -> one normalised JPEG (the real pixels go to the model)
 *   animated sticker / GIF / short video -> a few evenly spaced frames, in order, with timing
 *   voice note / audio -> a verbatim transcript (speech-to-text model; Luna still writes the reply)
 * Nothing here logs media bytes, URLs or keys. Every failure is returned as { ok:false, error } so the
 * caller can say honestly that it could not see/hear the media instead of pretending.
 *
 * Env (all optional): MEDIA_MAX_FRAMES (6) MEDIA_FRAME_PX (512) MEDIA_MAX_ANIM_SECONDS (12)
 *   MEDIA_MAX_AUDIO_SECONDS (180) OPENAI_TRANSCRIBE_MODEL (gpt-4o-transcribe) GROQ_TRANSCRIBE_MODEL (whisper-large-v3-turbo)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const cfg = () => ({
  maxFrames: Math.min(10, num(process.env.MEDIA_MAX_FRAMES, 6)),
  framePx: num(process.env.MEDIA_FRAME_PX, 512),
  imagePx: num(process.env.MEDIA_IMAGE_PX, 1280),
  maxAnimSeconds: num(process.env.MEDIA_MAX_ANIM_SECONDS, 12),
  maxAudioSeconds: num(process.env.MEDIA_MAX_AUDIO_SECONDS, 180),
  maxImageBytes: num(process.env.MEDIA_MAX_IMAGE_BYTES, 8e6),
  maxVideoBytes: num(process.env.MEDIA_MAX_VIDEO_BYTES, 6e6),
  maxAudioBytes: num(process.env.MEDIA_MAX_AUDIO_BYTES, 8e6),
});

/** Identify a file from its magic bytes — the declared mimetype is never trusted. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const s4 = buf.toString("latin1", 0, 4);
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (s4 === "\x89PNG") return "png";
  if (s4 === "GIF8") return "gif";
  if (s4 === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (s4 === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") return "wav";
  if (s4 === "OggS") return "ogg";
  if (s4 === "fLaC") return "flac";
  if (s4 === "\x1aE\xdf\xa3") return "webm";
  if (buf.toString("latin1", 4, 8) === "ftyp") return "mp4"; // mp4 / m4a / mov / 3gp family
  if (s4.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
  if (buf.toString("latin1", 0, 6) === "#!AMR\n") return "amr";
  return null;
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4e6 }, (err, stdout) => (err ? reject(new Error(`${cmd} failed`)) : resolve(String(stdout))));
  });
}
async function withTmp(buf, ext, fn) {
  const base = path.join(os.tmpdir(), `med_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const file = `${base}.${ext}`;
  fs.writeFileSync(file, buf);
  try { return await fn(file, base); }
  finally { fs.rm(file, () => {}); }
}
const sharpLib = () => require("sharp");

// ── IMAGES (photos + static stickers) ─────────────────────────
async function prepareStill(buf) {
  const c = cfg();
  const kind = sniff(buf);
  if (!["jpeg", "png", "webp", "gif"].includes(kind)) throw new Error("unsupported image format");
  const out = await sharpLib()(buf, { failOn: "error" }).rotate().flatten({ background: "#ffffff" })
    .resize(c.imagePx, c.imagePx, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { base64: out.toString("base64"), mimetype: "image/jpeg" };
}

// ── ANIMATIONS (animated WebP, GIF, mp4/webm "GIFs") ──────────
const evenly = (n, k) => (k >= n ? [...Array(n).keys()] : [...Array(k).keys()].map((i) => Math.round((i * (n - 1)) / (k - 1))));

async function framesFromPages(buf, c) {
  const sharp = sharpLib();
  const meta = await sharp(buf, { animated: true, failOn: "error" }).metadata();
  const pages = meta.pages || 1;
  const delays = Array.isArray(meta.delay) && meta.delay.length === pages ? meta.delay : Array(pages).fill(100);
  const picks = evenly(pages, c.maxFrames);
  const starts = []; let acc = 0;
  for (const d of delays) { starts.push(acc); acc += d || 100; }
  const frames = [];
  for (const i of picks) {
    const jpg = await sharp(buf, { page: i, failOn: "error" }).flatten({ background: "#ffffff" })
      .resize(c.framePx, c.framePx, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    frames.push({ base64: jpg.toString("base64"), mimetype: "image/jpeg", tMs: starts[i] });
  }
  return { frames, durationMs: acc, totalFrames: pages };
}

async function framesFromVideo(buf, ext, c) {
  return withTmp(buf, ext, async (file, base) => {
    let dur = 0;
    try { dur = parseFloat(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 15000)); } catch { throw new Error("unreadable video"); }
    if (!(dur > 0)) throw new Error("unreadable video");
    const span = Math.min(dur, c.maxAnimSeconds); // only the first N seconds are inspected
    const frames = [];
    for (let i = 0; i < c.maxFrames; i++) {
      const t = (span * (i + 0.5)) / c.maxFrames;
      const out = `${base}_${i}.jpg`;
      try {
        await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale='min(${c.framePx},iw)':-2`, "-q:v", "6", out], 20000);
        frames.push({ base64: fs.readFileSync(out).toString("base64"), mimetype: "image/jpeg", tMs: Math.round(t * 1000) });
      } catch { /* a frame that cannot be decoded is skipped */ } finally { fs.rm(out, () => {}); }
    }
    if (!frames.length) throw new Error("no frames could be decoded");
    return { frames, durationMs: Math.round(dur * 1000), totalFrames: null, truncated: dur > c.maxAnimSeconds };
  });
}

async function prepareAnimation(buf) {
  const c = cfg();
  const kind = sniff(buf);
  if (kind === "webp" || kind === "gif") {
    const r = await framesFromPages(buf, c);
    return r;
  }
  if (kind === "mp4" || kind === "webm") return framesFromVideo(buf, kind, c);
  throw new Error("unsupported animation format");
}

// ── VOICE NOTES ───────────────────────────────────────────────
const TRANSCRIBE_PROMPT = "Verbatim transcript of a WhatsApp voice note. The speaker may use Nigerian English, Nigerian Pidgin, Yoruba, Igbo or Hausa words, slang and mix languages mid-sentence. Write exactly what was said, do not translate, formalise or correct grammar, and write [unclear] for words you cannot make out.";
const NATIVE_AUDIO = new Set(["ogg", "mp3", "wav", "flac", "webm", "mp4"]);

async function toOggOpus(buf, ext) {
  return withTmp(buf, ext, async (file, base) => {
    const out = `${base}.ogg`;
    try { await run("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vn", "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", out], 30000); return fs.readFileSync(out); }
    finally { fs.rm(out, () => {}); }
  });
}

async function audioDurationSec(buf, ext) {
  try { return await withTmp(buf, ext, async (f) => parseFloat(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], 10000))); } catch { return null; }
}

/** POST a multipart transcription request. `post(url, formData, headers)` is injectable for tests. */
const defaultPost = async (url, form, headers) => {
  const res = await fetch(url, { method: "POST", body: form, headers, signal: AbortSignal.timeout(60000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${(data && data.error && data.error.message) || "transcription request failed"}`.slice(0, 160));
  return data;
};

function interpret(data, model) {
  const text = String((data && data.text) || "").trim();
  const segs = Array.isArray(data && data.segments) ? data.segments : [];
  let uncertain = false;
  if (segs.length) {
    const avg = segs.reduce((a, s) => a + (typeof s.avg_logprob === "number" ? s.avg_logprob : 0), 0) / segs.length;
    const noSpeech = Math.max(...segs.map((s) => (typeof s.no_speech_prob === "number" ? s.no_speech_prob : 0)));
    uncertain = avg < -0.9 || noSpeech > 0.6;
  }
  if (/\[unclear\]/i.test(text)) uncertain = true;
  return { text, uncertain, model };
}

async function transcribe(buf, { post = defaultPost, env = process.env } = {}) {
  const c = cfg();
  let kind = sniff(buf);
  if (!kind || ["jpeg", "png", "gif", "webp"].includes(kind)) throw new Error("not an audio file");
  let ext = kind === "amr" ? "amr" : kind;
  if (!NATIVE_AUDIO.has(kind)) { buf = await toOggOpus(buf, ext); kind = "ogg"; ext = "ogg"; }
  const dur = await audioDurationSec(buf, ext);
  if (dur && dur > c.maxAudioSeconds) throw new Error("voice note too long");
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const providers = [];
  if (env.OPENAI_API_KEY) providers.push({ name: "openai", url: `${base}/audio/transcriptions`, key: env.OPENAI_API_KEY, model: env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe" });
  if (env.GROQ_API_KEY) providers.push({ name: "groq", url: "https://api.groq.com/openai/v1/audio/transcriptions", key: env.GROQ_API_KEY, model: env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo" });
  if (!providers.length) throw new Error("no transcription provider configured");
  let lastErr;
  for (const p of providers) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: kind === "ogg" ? "audio/ogg" : `audio/${ext}` }), `voice.${ext}`);
      form.append("model", p.model);
      form.append("prompt", TRANSCRIBE_PROMPT);
      form.append("temperature", "0");
      if (!/gpt-4o/i.test(p.model)) form.append("response_format", "verbose_json"); // gives per-segment confidence
      const out = interpret(await post(p.url, form, { Authorization: `Bearer ${p.key}` }), p.model);
      return { ...out, provider: p.name, durationSec: dur };
    } catch (e) { lastErr = e; console.warn(`[media] ${p.name} transcription failed: ${e.message}`); }
  }
  throw lastErr || new Error("transcription failed");
}

// ── ORCHESTRATION ─────────────────────────────────────────────
/**
 * payload: { kind: image|sticker|animation|audio, base64, caption, seconds, error }
 * -> { ok, kind, images:[{base64,mimetype,tMs?}], transcript, uncertain, note, summary, error }
 */
async function prepare(payload, deps = {}) {
  const kind = payload && payload.kind;
  const fail = (error) => ({ ok: false, kind, images: [], error, note: failureNote(kind, error) });
  try {
    if (!payload) return fail("no media");
    if (payload.error) return fail(payload.error);
    if (!payload.base64) return fail("no media bytes arrived");
    const c = cfg();
    const buf = Buffer.from(payload.base64, "base64");
    const limit = kind === "audio" ? c.maxAudioBytes : kind === "animation" ? c.maxVideoBytes : c.maxImageBytes;
    if (!buf.length) return fail("empty media");
    if (buf.length > limit) return fail("too large");
    if (kind === "image" || kind === "sticker") {
      const img = await (deps.prepareStill || prepareStill)(buf);
      return { ok: true, kind, images: [img], note: kind === "sticker" ? "The image attached is a WhatsApp sticker they just sent." : "The image attached is a photo they just sent." };
    }
    if (kind === "animation") {
      const a = await (deps.prepareAnimation || prepareAnimation)(buf);
      const times = a.frames.map((f, i) => `frame ${i + 1} at ${(f.tMs / 1000).toFixed(1)}s`).join(", ");
      const what = payload.label ? `a ${payload.label}` : payload.gif ? "a GIF" : "an animated sticker";
      const trunc = a.truncated ? ` Only the first ${cfg().maxAnimSeconds}s were sampled.` : "";
      return { ok: true, kind, images: a.frames, durationMs: a.durationMs,
        note: `The ${a.frames.length} images attached are frames, in order, sampled evenly from ${what} they just sent (about ${(a.durationMs / 1000).toFixed(1)}s long: ${times}). Work out what it shows and how it changes from frame to frame.${trunc}` };
    }
    if (kind === "audio") {
      const t = await (deps.transcribe || transcribe)(buf, deps);
      if (!t.text) return { ok: true, kind, images: [], transcript: "", uncertain: true, note: "They sent a voice note but nothing intelligible could be transcribed. Tell them you could not make it out; do not guess what it said." };
      const warn = t.uncertain ? " Parts of the transcript are uncertain or marked [unclear]; do not invent the missing words, and say so if it matters." : "";
      return { ok: true, kind, images: [], transcript: t.text, uncertain: !!t.uncertain,
        note: `Their message above is an automatic transcript of a voice note they sent, wording kept as spoken. It may contain mistakes and cannot convey tone, laughter or hesitation.${warn} Reply to what they said, conversationally.` };
    }
    return fail("unsupported media kind");
  } catch (e) {
    console.warn(`[media] ${kind} processing failed: ${String(e.message).slice(0, 120)}`);
    return fail(e.message);
  }
}

function failureNote(kind, error) {
  const what = { image: "a photo", sticker: "a sticker", animation: "an animated sticker or GIF", audio: "a voice note" }[kind] || "some media";
  return `They sent ${what} but it could not be retrieved or processed (${String(error).slice(0, 60)}). You did NOT see or hear it. Do not guess or pretend; say naturally that it did not come through and ask them to resend or tell you.`;
}

/** Build the user turn for the model: text + the real images (Responses API input_image parts). */
function buildUserContent(text, prepared) {
  const note = prepared && prepared.note ? `[${prepared.note}]` : "";
  const body = [text, note].filter(Boolean).join("\n\n");
  if (!prepared || !prepared.ok || !prepared.images.length) return body;
  return [
    { type: "text", text: body },
    ...prepared.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mimetype};base64,${im.base64}` }, detail: prepared.images.length > 1 ? "low" : "auto" })),
  ];
}

/** For text-only fallbacks (Groq): drop image parts, keep the words. */
function flattenContent(content) {
  if (!Array.isArray(content)) return content;
  const t = content.filter((p) => p && p.type === "text").map((p) => p.text).join("\n");
  const n = content.filter((p) => p && p.type === "image_url").length;
  return n ? `${t}\n[${n} image(s) were attached but cannot be viewed by this model]` : t;
}

module.exports = { sniff, cfg, prepare, prepareStill, prepareAnimation, transcribe, buildUserContent, flattenContent, failureNote, TRANSCRIBE_PROMPT };
