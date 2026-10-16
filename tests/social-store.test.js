"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.SOCIAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "soc-"));
const test = require("node:test");
const assert = require("node:assert");
const store = require("../social/store");

// A fake supabase-js client for ariana_social_accounts. `failWith` makes writes fail; `rows` is the "table".
function fakeDb({ failWith = null, noAutopublishColumn = false, rows = [] } = {}) {
  const calls = [];
  return {
    rows, calls,
    from() {
      return {
        select: () => ({ order: async () => ({ data: [...rows], error: null }) }),
        upsert: async (row) => {
          calls.push(Object.keys(row));
          if (failWith) return { error: { message: failWith } };
          if (noAutopublishColumn && "autopublish" in row) return { error: { message: 'Could not find the \'autopublish\' column of \'ariana_social_accounts\' in the schema cache' } };
          const i = rows.findIndex((r) => r.account_id === row.account_id);
          if (i === -1) rows.push(row); else rows[i] = row;
          return { error: null };
        },
        delete: () => ({ eq: async (_c, id) => { const i = rows.findIndex((r) => r.account_id === id); if (i >= 0) rows.splice(i, 1); return { error: null }; } }),
      };
    },
  };
}
const acct = (id, extra = {}) => ({ account_id: id, platform: "twitter", handle: id, label: id, provider: "socialcrabs", actions_enabled: false, autopublish: false, status: "not_connected", status_detail: "", last_checked: null, created_at: new Date().toISOString(), ...extra });
const clearFile = () => fs.rmSync(path.join(process.env.SOCIAL_DATA_DIR, "accounts.json"), { force: true });

test("a normal save reaches the database and reports persisted", async () => {
  clearFile(); const db = fakeDb(); store._setSupabaseForTest(db);
  const r = await store.saveAccount(acct("twitter:ariana"));
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(db.rows.length, 1);
});

test("a database write that fails is REPORTED (not swallowed), and the account is still kept locally", async () => {
  clearFile(); const db = fakeDb({ failWith: "permission denied for table ariana_social_accounts" }); store._setSupabaseForTest(db);
  const r = await store.saveAccount(acct("twitter:ariana"));
  assert.strictEqual(r.persisted, false);
  assert.match(r.error, /permission denied/);
  assert.strictEqual((await store.loadAccounts()).length, 1, "still visible after the failed save");
});

test("accounts that exist only locally are shown and re-saved into the database (self-heal after a restart)", async () => {
  clearFile(); const db = fakeDb(); store._setSupabaseForTest(db);
  fs.writeFileSync(path.join(process.env.SOCIAL_DATA_DIR, "accounts.json"), JSON.stringify([acct("twitter:ariana")]));
  const list = await store.loadAccounts();
  assert.deepStrictEqual(list.map((a) => a.account_id), ["twitter:ariana"]);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(db.rows.length, 1, "it was written back to the database");
});

test("the database copy wins over the local one; no duplicates", async () => {
  clearFile(); const db = fakeDb({ rows: [acct("twitter:ariana", { label: "from db" })] }); store._setSupabaseForTest(db);
  fs.writeFileSync(path.join(process.env.SOCIAL_DATA_DIR, "accounts.json"), JSON.stringify([acct("twitter:ariana", { label: "from file" })]));
  const list = await store.loadAccounts();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].label, "from db");
});

test("an older table without the autopublish column still saves everything else", async () => {
  clearFile(); const db = fakeDb({ noAutopublishColumn: true }); store._setSupabaseForTest(db);
  const r = await store.saveAccount(acct("instagram:ariana", { platform: "instagram" }));
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(db.rows.length, 1);
  assert.ok(!("autopublish" in db.rows[0]));
});

test("deleting removes it from both places, so it does not come back", async () => {
  clearFile(); const db = fakeDb(); store._setSupabaseForTest(db);
  await store.saveAccount(acct("twitter:ariana"));
  await store.deleteAccount("twitter:ariana");
  assert.strictEqual((await store.loadAccounts()).length, 0);
});
