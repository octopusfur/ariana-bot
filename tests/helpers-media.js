"use strict";
// Real media fixtures built on the fly (no binary files in the repo).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");

const tmp = (ext) => path.join(os.tmpdir(), `fx_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const solid = (r, g, b, size = 96) => ({ create: { width: size, height: size, channels: 3, background: { r, g, b } } });
const jpeg = (r = 220, g = 30, b = 30) => sharp(solid(r, g, b)).jpeg().toBuffer();
const png = (r = 30, g = 30, b = 220) => sharp(solid(r, g, b)).png().toBuffer();
const staticWebp = (r = 20, g = 200, b = 20) => sharp(solid(r, g, b, 128)).webp().toBuffer();

/** A GIF whose colour changes red -> green -> blue (one second each at 4 fps). */
function colourGif() {
  const out = tmp("gif");
  const inputs = [["red"], ["green"], ["blue"]].flatMap(([c]) => ["-f", "lavfi", "-i", `color=c=${c}:s=96x96:d=1:r=4`]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0", out]);
  const b = fs.readFileSync(out); fs.rmSync(out); return b;
}
async function animatedWebp() { return sharp(colourGif(), { animated: true }).webp().toBuffer(); }
function longGif(frames = 60) {
  const out = tmp("gif");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=s=96x96:d=${frames / 10}:r=10`, out]);
  const b = fs.readFileSync(out); fs.rmSync(out); return b;
}
function mp4(seconds = 3) {
  const out = tmp("mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=s=160x160:d=${seconds}:r=10`, "-pix_fmt", "yuv420p", out]);
  const b = fs.readFileSync(out); fs.rmSync(out); return b;
}
function oggVoice() {
  const out = tmp("ogg");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=1.5", "-c:a", "libopus", out]);
  const b = fs.readFileSync(out); fs.rmSync(out); return b;
}
/** Dominant colour of a base64 JPEG: returns [r,g,b] means. */
async function meanColour(b64) { const s = await sharp(Buffer.from(b64, "base64")).stats(); return s.channels.slice(0, 3).map((c) => c.mean); }

module.exports = { hasFfmpeg, jpeg, png, staticWebp, colourGif, animatedWebp, longGif, mp4, oggVoice, meanColour };
