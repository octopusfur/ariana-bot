# Snapchat sidecar (Fly.io). No Playwright/Chromium: sign-in is pure HTTP or a pasted session.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
