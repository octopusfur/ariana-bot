// Stand-in for @whatsmeow-node/whatsmeow-node so the sidecar can be tested offline.
import fs from "node:fs";
const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n"); };
export function createClient() {
  const st = { connected: false };
  const h = {};
  return {
    on(ev, fn) { h[ev] = fn; }, close() {},
    async init() { return {}; },
    async getQRChannel() {},
    async connect() {
      st.connected = true;
      if (process.env.FAKE_EMIT) setTimeout(() => {
        h.connected && h.connected({ jid: "2340000000000@s.whatsapp.net" });
        if (process.env.FAKE_MESSAGE) h.message && h.message(JSON.parse(process.env.FAKE_MESSAGE));
      }, 80);
    },
    async isConnected() { return st.connected; },
    async pairCode() { if (!st.connected) throw new Error("not connected"); return "ABCD-EFGH"; },
    async isOnWhatsApp(phones) { return phones.map((p) => ({ query: p, isIn: true, jid: p.replace(/\D/g, "") + "@s.whatsapp.net" })); },
    async downloadAny() { const f = "/tmp/fake-sticker-" + Date.now() + ".webp"; fs.writeFileSync(f, Buffer.from("RIFFfakewebp")); return f; },
    async uploadMedia() { return { URL: "u", directPath: "d", mediaKey: "k", fileEncSHA256: "e", fileSHA256: "s", fileLength: 12 }; },
    async sendRawMessage(jid, msg) { log({ op: "sendRawMessage", jid, msg }); return { id: "x", timestamp: 1 }; },
    async sendMessage(jid, msg) { log({ op: "sendMessage", jid, msg }); return { id: "x", timestamp: 1 }; },
    async sendPresence() {}, async sendChatPresence() {}, async markRead() {},
  };
}
