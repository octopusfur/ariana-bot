# -ariana-bot
---

## WhatsApp (whatsapp-web.js)

Baileys has been removed. WhatsApp text now runs through `wa-web.js` (whatsapp-web.js + Chromium), started next to `index.js` by `npm start`.

**Render:** use the *Docker* runtime (the `Dockerfile` installs Chromium). Give it at least ~1–2 GB RAM; a 512 MB instance will likely be killed by Chromium.

| Env var | Purpose |
|---|---|
| `WA_PROVIDER` | `wwebjs` (default) or `kapso` (old Meta Cloud API path) |
| `PHONE_NUMBER` | Ariana's number with country code → pairing code instead of QR |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Session is backed up to a private Storage bucket (`wwebjs-session`, auto-created) so it survives redeploys |
| `WA_ADMIN_KEY` | Protects the linking pages: open `/wa?key=<WA_ADMIN_KEY>` |
| `WA_PROXY` | Optional `http://user:pass@host:port` for Chromium. Leave unset to connect directly |

Link the number at `/wa` (pairing code or QR). Reset a bad session with `POST /api/whatsapp/reset-auth`, then restart.

## WaCalls (parallel audio/video calling)

The optional `wacalls.js` adapter runs alongside the existing WhatsApp transport and does not replace it. It adds WaCalls lifecycle events, auto-answer, outgoing audio/video controls, and a modular STT → Ariana LLM → TTS call-turn endpoint. See [WACALLS.md](WACALLS.md) and [.env.example](.env.example) for pairing, configuration, media-bridge details, and the upstream text capability note.
