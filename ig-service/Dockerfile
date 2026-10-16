# Ariana's Instagram service (Render: Docker runtime, Root Directory = ig-service).
# No browser, no Chromium: plain Python + HTTP, so it idles at roughly 60-110 MB.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

# Render sets PORT; app.py listens on it.
EXPOSE 10000
CMD ["python", "app.py"]
