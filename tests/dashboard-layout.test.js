"use strict";
// Guards the "screens only scroll up and down" rules in the dashboard (verified in a real mobile Chromium: with a wide child
// inside the media list, the old page let the list pan sideways to -147px; these rules keep it at 0).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("screens and their scroll bodies cannot scroll sideways", () => {
  assert.match(html, /\.scr,\.sbody\{[^}]*overflow-x:hidden[^}]*touch-action:pan-y/);
});
test("the media grid cannot be pushed wider than the screen", () => {
  assert.match(html, /#s-media \.mgrid2\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(html, /#s-media \.media-tabs\{[^}]*flex-wrap:wrap[^}]*overflow-x:hidden/);
});
test("a safety net puts any sideways nudge straight back", () => {
  assert.match(html, /document\.addEventListener\('scroll',function\(e\)\{[\s\S]*?scrollLeft=0/);
});
test("every conversation row shows the number or ID with a copy button, and private Signal IDs can be looked up", () => {
  assert.match(html, /function convoNumber\(c\)/);
  assert.match(html, /findSignalNumber\(this\.dataset\.id,this\)/);
  assert.match(html, /copyVal\(this\.dataset\.v,this\)/);
});
