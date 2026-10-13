"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { analyzeVoice, waveformFromPcm, fallbackWaveform, BINS } = require("../voice_wave");
const fx = require("./helpers-media");
const skipFx = fx.hasFfmpeg ? false : "ffmpeg not installed";

function pcmRamp(n = 6400) { // amplitude rises from quiet to loud
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((i / n) * 20000 * Math.sin(i / 3)), i * 2);
  return b;
}

test("waveform is 64 bars in 0-100, loudest bar is 100, and follows the loudness", () => {
  const w = waveformFromPcm(pcmRamp());
  assert.strictEqual(w.length, BINS);
  assert.ok([...w].every((v) => v >= 0 && v <= 100));
  assert.strictEqual(Math.max(...w), 100);
  assert.ok(w[BINS - 2] > w[4] + 30, "louder end gives taller bars than the quiet start");
});

test("silence gives a flat, low wave instead of noise", () => {
  const w = waveformFromPcm(Buffer.alloc(16000));
  assert.ok([...w].every((v) => v <= 5));
});

test("fallback wave looks natural (varied, in range) and is deterministic per seed", () => {
  const a = fallbackWaveform(1234), b = fallbackWaveform(1234), c = fallbackWaveform(99);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c);
  assert.ok([...a].every((v) => v >= 0 && v <= 100));
  assert.ok(new Set(a).size > 10);
});

test("analyzeVoice measures real length and a 64-byte wave from an OGG/Opus file", { skip: skipFx }, async () => {
  const out = path.join(os.tmpdir(), `vw_${Date.now()}.ogg`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-c:a", "libopus", out]);
  const buf = fs.readFileSync(out); fs.rmSync(out);
  const r = await analyzeVoice(buf);
  assert.strictEqual(r.measured, true);
  assert.strictEqual(r.seconds, 3);
  assert.strictEqual(r.waveform.length, BINS);
  assert.strictEqual(Math.max(...r.waveform), 100);
});

test("analyzeVoice never throws: undecodable audio still gets a length and a wave", async () => {
  const r = await analyzeVoice(Buffer.from("definitely not audio, but long enough ".repeat(400)));
  assert.strictEqual(r.measured, false);
  assert.ok(r.seconds >= 1);
  assert.strictEqual(r.waveform.length, BINS);
});
