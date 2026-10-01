# Main Ariana service (Render). No browser here — WhatsApp text runs separately (see Dockerfile.wa / fly.toml).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates dumb-init procps \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
