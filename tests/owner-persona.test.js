"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { noteFor, isDevMessage } = require("../owner_persona");

test("with the owner she stays fully in character and handles failures like a person would", () => {
  const n = noteFor({ isOwner: true, enabled: true, text: "hey you" });
  assert.match(n, /never step out of being Ariana/);
  assert.match(n, /as an AI/);
  assert.match(n, /ugh my phone/);
});

test("'dev:' is the escape hatch: that one message gets a plain technical answer", () => {
  for (const m of ["dev: why did the sticker fail", "  DEV - what did you receive", "dev:what happened"]) assert.ok(isDevMessage(m), m);
  for (const m of ["device broke", "developer mode lol", "hey dev", "what's dev: about"]) assert.ok(!isDevMessage(m), m);
  assert.match(noteFor({ isOwner: true, enabled: true, text: "dev: why" }), /DEV MODE for this message only/);
});

test("it never applies to anyone but the owner, and not when switched off", () => {
  assert.strictEqual(noteFor({ isOwner: false, enabled: true, text: "hi" }), "");
  assert.strictEqual(noteFor({ isOwner: true, enabled: false, text: "hi" }), "");
  assert.strictEqual(noteFor({ isOwner: false, enabled: true, text: "dev: hi" }), "");
});
