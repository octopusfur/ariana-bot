# WaCalls integration

WaCalls runs **in parallel** with `wa-web.js`; enabling it does not change `WA_PROVIDER` or remove the existing session. Ariana uses one configured WaCalls session (`WACALLS_SESSION_ID=ariana`).

## Setup and pairing

1. Run a trusted WaCalls server and keep its database on persistent storage. The upstream server has no authentication; do not expose it publicly unless your build supports `WACALLS_API_KEY` or it is behind an authenticated proxy.
2. Open the WaCalls UI, create exactly one session named `ariana`, then scan its QR in **WhatsApp → Linked devices → Link a device**. WaCalls persists the linked-device session in `wacalls.db`.
3. Configure the variables documented in `.env.example`, especially:
   - `WHATSAPP_NUMBER`: Ariana's full number with country code (inventory/config; WaCalls pairing itself uses QR).
   - `WACALLS_URL`, `WACALLS_SESSION_ID=ariana`, and optionally `WACALLS_API_KEY`.
   - `WACALLS_ENABLED=true` only after the server/session exists.
   - `WACALLS_AUTO_ANSWER=true` to accept incoming calls automatically.
4. Start Ariana with `npm start`. Look for `[WaCalls] connected (ariana)`. Check `GET /api/wacalls/status` (dashboard authentication applies).

`wacalls.js` reconnects its SSE stream with exponential backoff and logs connection, message, incoming-call, answered, ended, and error events.

## What handles what

- `wacalls.js`: one-session WaCalls HTTP/SSE adapter, incoming events, auto-answer, outgoing call/message commands.
- `index.js` `/integrations/wacalls/message`: incoming text/caption → existing `handleMessage` → Ariana LLM → WaCalls reply.
- `index.js` `/integrations/wacalls/calls/:callId/turn`: final STT transcript → Ariana LLM/memory → Cartesia/ElevenLabs TTS audio response.
- `index.js` `/api/wacalls/calls`: starts an audio call (`{ "to": "1555..." }`) or video call (`{ "to": "1555...", "video": true }`).
- `index.js` `/api/wacalls/calls/:id/answer|reject|end`: lifecycle controls.

## Audio and video media bridge

WaCalls transports call audio as raw signed little-endian 16 kHz PCM over its WebRTC `audio` data channel. Its browser bridge (or a headless WebRTC worker) should:

1. send inbound PCM to the configured streaming STT provider;
2. after a final utterance, POST `{ "from": "1555...", "transcript": "..." }` to `/integrations/wacalls/calls/<callId>/turn` (include `X-WaCalls-Secret` when configured);
3. decode the returned MP3 `audioBase64`, resample to mono 16 kHz PCM, and write frames to WaCalls' audio data channel.

The response includes `video.avatarReady=true`. Keep the existing video data channel attached as passthrough/placeholder; a future avatar renderer can consume the same reply/audio and publish frames without changing call or LLM logic.

> **Upstream capability note:** the reference WaCalls server currently exposes native call signalling/media but no chat message endpoint. Text-through-WaCalls therefore requires a chat-capable WaCalls build/fork that emits message SSE events and accepts `WACALLS_MESSAGE_PATH`. Until then, text continues safely through the existing `wa-web.js` implementation while audio calls use WaCalls. This adapter intentionally supports the extension without falsely replacing working text transport.

## HTTP examples

```bash
# Status
curl http://localhost:3000/api/wacalls/status

# Outgoing audio/video
curl -X POST http://localhost:3000/api/wacalls/calls \
  -H 'content-type: application/json' -d '{"to":"15551234567"}'
curl -X POST http://localhost:3000/api/wacalls/calls \
  -H 'content-type: application/json' -d '{"to":"15551234567","video":true}'

# Simulate one voice turn from the media/STT worker
curl -X POST http://localhost:3000/integrations/wacalls/calls/test-call/turn \
  -H 'content-type: application/json' -d '{"from":"15551234567","transcript":"hey, can you hear me?"}'
```
