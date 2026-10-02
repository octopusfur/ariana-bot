FROM bbernhard/signal-cli-rest-api:latest

# json-rpc mode: needed for the live /v1/receive websocket Ariana listens on.
ENV MODE=json-rpc

# start.sh restores the linked Signal account from Supabase Storage on boot and backs it up every 5 min,
# so a restart/redeploy doesn't unlink her. Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl tar ca-certificates && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
RUN chmod +x /start.sh
ENTRYPOINT ["/start.sh"]
