// Stand-in for @whatsmeow-node/whatsmeow-node so the sidecar's HTTP wiring can be tested offline.
export function createClient() {
  const st = { connected: false };
  return {
    on() {}, close() {},
    async init() { return {}; },
    async getQRChannel() {},
    async connect() { st.connected = true; },
    async isConnected() { return st.connected; },
    async pairCode(phone) { if (!st.connected) throw new Error("not connected"); return "ABCD-EFGH"; },
    async sendPresence() {}, async sendChatPresence() {}, async markRead() {},
  };
}
