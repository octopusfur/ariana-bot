"use strict";
/**
 * voice_wave.js — the two things WhatsApp needs on a push-to-talk voice note so it looks like a real one:
 *   seconds   (the length shown on the bubble; without it the note shows 0:00)
 *   waveform  (64 bytes, 0-100, the bars drawn instead of a plain slider)
 * Both are measured from the actual audio with ffmpeg. If ffmpeg is unavailable or the file cannot be
 * decoded we still return a plausible length (estimated from the Opus bitrate) and a natural-looking
 * wave, so the note never goes out as a bare slider.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const BINS = 64;
const RATE = 8000; // analysis sample rate (mono s16le) — plenty for a loudness envelope

/** 64 loudness bars (0-100) from mono 16-bit little-endian PCM. */
function waveformFromPcm(pcm, bins = BINS) {
  const n = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(bins);
  if (n < bins) return out.fill(3);
  const rms = [];
  for (let b = 0; b < bins; b++) {
    const from = Math.floor((b * n) / bins), to = Math.floor(((b + 1) * n) / bins);
    let sum = 0;
    for (let i = from; i < to; i++) { const s = pcm.readInt16LE(i * 2); sum += s * s; }
    rms.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  const max = Math.max(...rms);
  if (max < 40) return out.fill(3); // effectively silence
  for (let b = 0; b < bins; b++) out[b] = Math.max(3, Math.min(100, Math.round(100 * Math.pow(rms[b] / max, 0.7))));
  return out;
}

/** Natural-looking stand-in wave (deterministic for a given seed) used only when the audio can't be decoded. */
function fallbackWaveform(seed, bins = BINS) {
  let x = (Number(seed) || 1) % 2147483647 || 1;
  const rnd = () => (x = (x * 48271) % 2147483647) / 2147483647;
  const out = Buffer.alloc(bins);
  let level = 0.5;
  for (let i = 0; i < bins; i++) {
    level = Math.max(0.12, Math.min(1, level + (rnd() - 0.5) * 0.55));
    out[i] = Math.round(18 + level * 80);
  }
  return out;
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (err) => (err ? reject(err) : resolve())));
}

/** { seconds, waveform: Buffer(64), measured } for an audio buffer (typically the OGG/Opus we are about to send). */
async function analyzeVoice(buf, estimateBytesPerSecond = 4000) {
  const base = path.join(os.tmpdir(), `wave_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(`${base}.in`, buf);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", `${base}.in`, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", `${base}.pcm`], 30000);
    const pcm = fs.readFileSync(`${base}.pcm`);
    if (pcm.length < RATE / 2) throw new Error("audio too short to measure");
    return { seconds: Math.max(1, Math.round(pcm.length / 2 / RATE)), waveform: waveformFromPcm(pcm), measured: true };
  } catch (e) {
    return { seconds: Math.max(1, Math.round(buf.length / estimateBytesPerSecond)), waveform: fallbackWaveform(buf.length), measured: false };
  } finally {
    fs.rm(`${base}.in`, () => {}); fs.rm(`${base}.pcm`, () => {});
  }
}

module.exports = { analyzeVoice, waveformFromPcm, fallbackWaveform, BINS };
