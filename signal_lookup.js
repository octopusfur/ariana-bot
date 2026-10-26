"use strict";
/**
 * signal_lookup.js — find the phone number behind a Signal contact that arrived as a private ID (UUID).
 * Uses the signal-cli REST API's identity list for the linked account (GET /v1/identities/{account}), which pairs each known
 * contact's number with its uuid. If Signal never shared the number with this account, there is nothing to find and we say so.
 */
const axios = require("axios");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stripPrefix = (id) => String(id || "").replace(/^sg_/, "").trim();

/** -> { ok, number|null, reason? } */
async function resolveNumber(id, { base, account, http = axios } = {}) {
  const raw = stripPrefix(id);
  if (/^\+?\d{6,15}$/.test(raw)) return { ok: true, number: raw.startsWith("+") ? raw : `+${raw}` }; // already a number
  if (!UUID.test(raw)) return { ok: false, number: null, reason: "not a Signal ID" };
  if (!base || !account) return { ok: false, number: null, reason: "Signal is not set up on this server" };
  let list;
  try {
    const r = await http.get(`${base}/v1/identities/${encodeURIComponent(account)}`, { timeout: 15000 });
    list = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    return { ok: false, number: null, reason: `Signal service did not answer (${String(e.message).slice(0, 60)})` };
  }
  const hit = list.find((i) => i && String(i.uuid || "").toLowerCase() === raw.toLowerCase() && /^\+?\d{6,15}$/.test(String(i.number || "")));
  if (!hit) return { ok: true, number: null, reason: "Signal has not shared this contact's phone number with Ariana's account" };
  return { ok: true, number: hit.number.startsWith("+") ? hit.number : `+${hit.number}` };
}
module.exports = { resolveNumber };
