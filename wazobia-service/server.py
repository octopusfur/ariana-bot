"""
WazobiaVoice TTS service for Ariana.

Wraps github.com/Ememzyvisuals/wazobiavoice-TTS in a tiny HTTP API so Ariana (Node, on Render)
can ask for Pidgin / Yoruba speech. Needs a GPU host (CPU works but is far too slow for chat).

  GET  /health
  POST /tts   {"text": "...", "language_id": "pcm"|"yo"|"ha"|"ig"|"en", "exaggeration": 0.55, "cfg_weight": 0.55}
              -> audio/mpeg

Env:
  WAZOBIA_TTS_KEY   shared secret; callers send  Authorization: Bearer <key>   (required in production)
  REF_AUDIO_URL     URL of a 5-10s clean clip of Ariana's voice to clone (downloaded once at startup)
  REF_AUDIO_PATH    ...or a path baked into the image (used if REF_AUDIO_URL is unset)
"""
import hmac
import os
import subprocess
import tempfile
import threading
import urllib.request

import torch
import torchaudio as ta
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from wazobiavoice_tts.mtl_tts import SUPPORTED_LANGUAGES, WazobiaVoiceMultilingualTTS

KEY = os.environ.get("WAZOBIA_TTS_KEY", "")
MAX_CHARS = 600

app = FastAPI(title="WazobiaVoice TTS")
_lock = threading.Lock()  # one generation at a time per GPU
_state = {"model": None, "ref": None}


def _load_reference():
    url = os.environ.get("REF_AUDIO_URL")
    if url:
        path = os.path.join(tempfile.gettempdir(), "ariana_ref.wav")
        urllib.request.urlretrieve(url, path)
        return path
    path = os.environ.get("REF_AUDIO_PATH")
    return path if path and os.path.exists(path) else None


@app.on_event("startup")
def _startup():
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _state["model"] = WazobiaVoiceMultilingualTTS.from_pretrained(device)
    _state["ref"] = _load_reference()


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    language_id: str
    exaggeration: float = 0.55
    cfg_weight: float = 0.55


def _check_auth(authorization):
    if not KEY:
        return  # open (local testing only — set WAZOBIA_TTS_KEY in production)
    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(supplied, KEY):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health():
    return {"ok": _state["model"] is not None, "reference_voice": bool(_state["ref"]), "device": str(torch.device("cuda" if torch.cuda.is_available() else "cpu"))}


@app.post("/tts")
def tts(req: TTSRequest, authorization: str = Header(default=None)):
    _check_auth(authorization)
    if _state["model"] is None:
        raise HTTPException(status_code=503, detail="model still loading")
    if req.language_id not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"unsupported language_id: {req.language_id}")

    with _lock, tempfile.TemporaryDirectory() as tmp:
        wav = _state["model"].generate(
            req.text,
            language_id=req.language_id,
            audio_prompt_path=_state["ref"],
            exaggeration=req.exaggeration,
            cfg_weight=req.cfg_weight,
        )
        wav_path, mp3_path = os.path.join(tmp, "o.wav"), os.path.join(tmp, "o.mp3")
        ta.save(wav_path, wav.cpu(), _state["model"].sr)
        # mp3 so WhatsApp/Telegram voice notes play everywhere without extra conversion
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-codec:a", "libmp3lame", "-b:a", "96k", mp3_path], check=True)
        with open(mp3_path, "rb") as f:
            return Response(content=f.read(), media_type="audio/mpeg")
