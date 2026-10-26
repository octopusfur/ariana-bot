"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { resolveNumber } = require("../signal_lookup");

const U = "1f3b9a40-5c2e-4d7a-9a11-77aa22bb33cc";
const http = (data, fail) => ({ get: async (url) => { if (fail) throw new Error("ECONNREFUSED"); http.last = url; return { data }; } });

test("a private ID is turned back into the phone number when Signal knows it", async () => {
  const h = http([{ number: "+2349015007290", uuid: U }, { number: "+15551230000", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }]);
  const r = await resolveNumber(`sg_${U}`, { base: "https://sig.example", account: "+14303629477", http: h });
  assert.deepStrictEqual(r, { ok: true, number: "+2349015007290" });
  assert.strictEqual(http.last, "https://sig.example/v1/identities/%2B14303629477");
});

test("matching is case-insensitive and adds the + sign", async () => {
  const r = await resolveNumber(U.toUpperCase(), { base: "b", account: "a", http: http([{ number: "2349015007290", uuid: U }]) });
  assert.strictEqual(r.number, "+2349015007290");
});

test("when Signal never shared the number, it says so instead of guessing", async () => {
  const r = await resolveNumber(U, { base: "b", account: "a", http: http([{ number: "+1555", uuid: "x" }, { uuid: U }]) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.number, null);
  assert.match(r.reason, /has not shared/);
});

test("numbers pass straight through; junk and unreachable services are reported", async () => {
  assert.deepStrictEqual(await resolveNumber("sg_2349015007290", {}), { ok: true, number: "+2349015007290" });
  assert.strictEqual((await resolveNumber("hello", {})).ok, false);
  const down = await resolveNumber(U, { base: "b", account: "a", http: http([], true) });
  assert.strictEqual(down.ok, false);
  assert.match(down.reason, /did not answer/);
  assert.strictEqual((await resolveNumber(U, {})).ok, false);
});
