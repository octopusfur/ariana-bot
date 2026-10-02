# WazobiaVoice TTS service — build on a GPU host (RunPod, Modal, a Hugging Face GPU Space, Fly GPU, etc.)
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ffmpeg curl ca-certificates software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa && apt-get update \
    && apt-get install -y --no-install-recommends python3.12 python3.12-venv python3.12-dev \
    && rm -rf /var/lib/apt/lists/*
RUN python3.12 -m venv /venv
ENV PATH="/venv/bin:$PATH"
WORKDIR /app
RUN git clone --depth 1 https://github.com/Ememzyvisuals/wazobiavoice-TTS.git model
# The repo's own staged installer (a plain `pip install .` fails on this stack — see its README)
RUN cd model && bash scripts/install.sh
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" pydantic
COPY server.py /app/server.py
# Optional: bake Ariana's reference voice into the image instead of using REF_AUDIO_URL
# COPY ref.wav /app/ref.wav
# ENV REF_AUDIO_PATH=/app/ref.wav
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
