// social/engine_client.js
// ─────────────────────────────────────────────────────────────────────────────
// The one seam between Ariana's social layer (guards, tools, autonomy, dashboard) and whatever
// actually talks to the platform. It is the built-in X engine (x_engine.js): in-process, plain HTTP,
// no browser, no extra service, no paid X API.
//
// Every function resolves { ok: true, ... } or { ok: false, error, code } and never throws, so a
// failing platform degrades to a message, never to a broken conversation.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const x = require('./x_engine');

module.exports = {
  provider: x.provider,
  configured: x.configured,
  configHint: x.configHint,
  baseUrl: x.baseUrl,
  health: x.health,
  capabilities: x.capabilities,
  sessions: x.sessions,
  sessionStatus: x.sessionStatus,
  verify: x.verify,
  importSession: x.importSession,
  disconnect: x.disconnect,
  act: x.act,
  connect: x.connect,
  submitCode: x.submitCode,
  hasPendingLogin: x.hasPendingLogin,
  x,
};
