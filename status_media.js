"use strict";
// status_media.js — get a picture or video ready for a status / story: download, validate, shrink.
// Videos are re-encoded to a small H.264 MP4 (max 30 s, 4.5 MB) because WhatsApp status and Telegram stories need that,
// and because the main app and the WhatsApp sidecar pass media around inside JSON.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const axios = require("axios");

const MAX_DOWNLOAD = 40 * 1024 * 1024, MAX_OUT_BYTES = 4.5 * 1024 * 1024, MAX_SECONDS = 30;
const run = (cmd, args, timeout = 90000) => new Promise((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 4e6 }, (e, out) => (e ? rej(new Error(`${cmd} failed`)) : res(String(out)))));

async function download(url, { http = axios, max = MAX_DOWNLOAD } = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("not a web address");
  const r = await http.get(url, { responseType: "arraybuffer", timeout: 30000, maxContentLength: max, maxBodyLength: max });
  const buf = Buffer.from(r.data);
  if (!buf.length) throw new Error("empty download");
  return { buf, contentType: String((r.headers && r.headers["content-type"]) || "").split(";")[0] };
}

async function loadImage(url, deps = {}) {
  const { buf, contentType } = await download(url, { ...deps, max: 20 * 1024 * 1024 });
  try {
    const out = await require("sharp")(buf).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
    return { base64: out.toString("base64"), mimetype: "image/jpeg", buffer: out };
  } catch { throw new Error(`not a usable picture${contentType ? ` (${contentType})` : ""}`); }
}

/** Re-encode any video to a small MP4. Returns { base64, buffer, mimetype, durationSec, width, height }. */
async function prepareVideo(buf) {
  const base = path.join(os.tmpdir(), `sv_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const inp = `${base}.in`, out = `${base}.mp4`;
  fs.writeFileSync(inp, buf);
  try {
    let dur = 0;
    try { dur = parseFloat(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inp], 20000)); } catch { throw new Error("not a readable video"); }
    if (!(dur > 0.3)) throw new Error("not a readable video");
    let last = null;
    for (const [px, crf] of [[720, 28], [540, 31], [480, 34]]) {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-t", String(MAX_SECONDS), "-vf", `scale='min(${px},iw)':-2`, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "96k", "-ac", "2", out]);
      last = fs.readFileSync(out);
      if (last.length <= MAX_OUT_BYTES) break;
    }
    if (!last || last.length > MAX_OUT_BYTES) throw new Error("video is too large even after compressing");
    const dim = (await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out], 20000)).trim().split(",").map(Number);
    return { base64: last.toString("base64"), buffer: last, mimetype: "video/mp4", durationSec: Math.min(dur, MAX_SECONDS), sourceDurationSec: dur, width: dim[0] || 0, height: dim[1] || 0 };
  } finally { fs.rm(inp, () => {}); fs.rm(out, () => {}); }
}
async function loadVideo(url, deps = {}) { return prepareVideo((await download(url, deps)).buf); }

module.exports = { loadImage, loadVideo, prepareVideo, download };
