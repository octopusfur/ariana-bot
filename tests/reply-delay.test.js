"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { delayMs } = require("../reply_delay");

test("her owner always gets an instant answer", () => {
  for (const msg of ["hi", "a much longer message ".repeat(10)]) assert.strictEqual(delayMs(msg, { isOwner: true, scale: "1", rand: () => 0.9 }), 0);
});

test("everyone else waits: 8-20s short, 15-40s medium, 30-70s long", () => {
  const lo = { rand: () => 0.5 };
  assert.ok(delayMs("hi", { ...lo, rand: () => 0 }) >= 8000);
  assert.ok(delayMs("hi", { rand: () => 0.5 }) <= 20000);
  const med = delayMs("how was your day today?", { rand: () => 0.5 });
  assert.ok(med >= 15000 && med <= 40000, med);
  const long = delayMs("this is a long message ".repeat(5), { rand: () => 0.5 });
  assert.ok(long >= 30000 && long <= 70000, long);
});

test("a leftover HUMAN_DELAY_SCALE of 0 (or junk) never makes her instant with other people", () => {
  for (const scale of ["0", "", undefined, "abc", "-1"]) assert.ok(delayMs("hi", { scale, rand: () => 0 }) >= 8000, String(scale));
});

test("the scale can still shorten or stretch the pause for other people", () => {
  assert.strictEqual(delayMs("hi", { scale: "0.5", rand: () => 0 }), 4000);
  assert.strictEqual(delayMs("hi", { scale: "2", rand: () => 0 }), 16000);
});
