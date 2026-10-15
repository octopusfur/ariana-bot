# Ariana's X service (Render: Docker runtime, Root Directory = x-service).
FROM python:3.12-slim

# One pinned commit of X's official xmcp. Bump this to update it; the service
# tests (tests/) tell you whether the new commit still behaves.
ARG XMCP_COMMIT=63d34362d88ed9f94d54ccd5ecd5bb4d12e11759

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 XMCP_DIR=/opt/xmcp
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/xmcp \
 && curl -fsSL "https://codeload.github.com/xdevplatform/xmcp/tar.gz/${XMCP_COMMIT}" \
    | tar -xz --strip-components=1 -C /opt/xmcp \
 && test -f /opt/xmcp/server.py

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Render sets PORT; app.py listens on it.
EXPOSE 10000
CMD ["python", "app.py"]
