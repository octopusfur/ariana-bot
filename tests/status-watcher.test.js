"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STATE_SYNC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sw-"));
const sw = require("../status_watcher");
const { defaults } = require("../controls");

const CFG = defaults({}).watch;
const T0 = Date.UTC(2026, 9, 13, 16, 0); // noon in New York
const items = (n, caption = "", t0 = T0 - 20 * 3600000, gap = 1000) => Array.from({ length: n }, (_, i) => ({ id: `i${Math.random().toString(36).slice(2)}${i}`, kind: "image", caption, ts: t0 + i * gap }));

test("someone who dumps 200 pictures at once is skipped, even a friend", () => {
  const p = { number: "1", name: "Dump", items: items(200) };
  assert.strictEqual(sw.judgePoster(p, CFG, { known: true }).skip, true);
  assert.match(sw.judgePoster(p, CFG, { known: true }).reason, /200/);
  assert.strictEqual(sw.judgePoster({ items: items(CFG.maxPerPoster, "", T0 - 20 * 3600000, 1800000) }, CFG, { known: true }).skip, false, "a normal amount, spread out, is fine");
  assert.strictEqual(sw.judgePoster({ items: items(CFG.maxPerPoster + 1, "", T0 - 20 * 3600000, 1800000) }, CFG, { known: true }).skip, true);
});

test("a burst inside half an hour counts as flooding", () => {
  const burst = Array.from({ length: 9 }, (_, i) => ({ id: "b" + i, kind: "image", caption: "", ts: T0 + i * 60000 }));
  assert.strictEqual(sw.isFlood(burst, CFG), true);
  const spread = Array.from({ length: 9 }, (_, i) => ({ id: "s" + i, kind: "image", caption: "", ts: T0 + i * 3 * 3600000 }));
  assert.strictEqual(sw.isFlood(spread, CFG), false);
});

test("vendors and promoters are skipped: business accounts, prices, DM to order, phone numbers", () => {
  const v = (caps) => caps.map((c, i) => ({ id: "v" + i, kind: "image", caption: c, ts: T0 }));
  assert.strictEqual(sw.looksLikeVendor(v(["x"]), { isBusiness: true }), true);
  assert.strictEqual(sw.looksLikeVendor(v(["Brand new sneakers ₦25,000 DM to order", "Available in all sizes, delivery nationwide"]), {}, false), true);
  assert.strictEqual(sw.looksLikeVendor(v(["Call 08012345678 now for wholesale"]), {}, false), true);
  assert.strictEqual(sw.looksLikeVendor(v(["sunset in miami", "dinner with the girls"]), {}, true), false);
  // a friend saying one shopping word is NOT a vendor
  assert.strictEqual(sw.looksLikeVendor(v(["finally going to buy those boots lol", "brunch", "gym"]), {}, true), false);
});

test("by default she only looks at people she already knows", () => {
  const p = { items: items(2, "hello") };
  assert.strictEqual(sw.judgePoster(p, CFG, { known: false }).skip, true);
  assert.strictEqual(sw.judgePoster(p, { ...CFG, onlyKnown: false }, { known: false }).skip, false);
});

test("her decisions: bad or missing JSON means no reaction; reactions need a real emoji, replies need clean text", () => {
  assert.deepStrictEqual(sw.parseDecisions("nonsense", 2), []);
  const d = sw.parseDecisions('{"items":[{"n":1,"interest":9,"do":"react","emoji":"😂"},{"n":2,"interest":9,"do":"react","emoji":"lol"},{"n":3,"interest":8,"do":"reply","text":"as an AI I think"},{"n":9,"interest":9,"do":"react","emoji":"❤️"}]}', 3);
  assert.strictEqual(d.length, 3, "n out of range is dropped");
  assert.strictEqual(d[0].act, "react");
  assert.strictEqual(d[1].act, "none", "not an emoji");
  assert.strictEqual(d[2].act, "none", "sounds like an AI");
});

function bot(over = {}) {
  let clock = T0;
  const calls = { view: [], react: [], reply: [], generate: 0 };
  const posters = over.posters || [];
  const deps = {
    now: () => clock, rand: over.rand || (() => 0.1), sleep: async () => {},
    cfg: () => ({ ...CFG, ...(over.cfg || {}) }), enabled: () => true, isConnected: async () => true,
    snapshot: async () => posters, businessInfo: async () => over.info || {}, isKnown: () => true, relation: () => "a friend",
    generate: async () => { calls.generate++; return over.answer || '{"items":[{"n":1,"interest":2,"do":"none"}]}'; },
    view: async (p, ids) => calls.view.push([p.number, ids]), react: async (p, id, e) => calls.react.push([p.number, e]), reply: async (p, id, t) => calls.reply.push([p.number, t]),
  };
  return { b: require("../status_watcher").create(deps), calls, setClock: (t) => (clock = t) };
}

test("a session skips the flooder and the vendor, and only looks at the normal person", async () => {
  const { b, calls } = bot({
    posters: [
      { jid: "a", number: "100", name: "Flood", items: items(200) },
      { jid: "b", number: "200", name: "Shop", items: items(2, "Price ₦5k, DM to order") },
      { jid: "c", number: "300", name: "Friend", items: items(2, "good morning") },
    ],
  });
  const rep = await b.session();
  assert.strictEqual(rep.skipped, 2);
  assert.deepStrictEqual(calls.view.map((v) => v[0]), ["300"], "only the friend was opened");
  const reasons = b.state.log.filter((l) => l.kind === "skipped").map((l) => l.detail).join("|");
  assert.match(reasons, /200 in a day/); assert.match(reasons, /vendor/);
});

test("she doesn't react to boring statuses, but does to something that catches her, once per person", async () => {
  const posters = [{ jid: "c", number: "300", name: "Friend", items: items(1, "puppy!") }];
  const boring = bot({ posters });
  await boring.b.session();
  assert.strictEqual(boring.calls.react.length + boring.calls.reply.length, 0);

  const fun = bot({ posters, answer: '{"items":[{"n":1,"interest":9,"do":"react","emoji":"😍"}]}' });
  await fun.b.session();
  assert.deepStrictEqual(fun.calls.react, [["300", "😍"]]);
  // same person again soon: no second reaction
  posters.push({ jid: "c", number: "300", name: "Friend", items: items(1, "another") });
  posters.splice(0, 1);
  await fun.b.session();
  assert.strictEqual(fun.calls.react.length, 1);
});

test("switches are respected: reactions off, daily caps, and the daily limit of people", async () => {
  const posters = [{ jid: "c", number: "300", name: "F", items: items(1, "x") }];
  const off = bot({ posters, cfg: { react: false }, answer: '{"items":[{"n":1,"interest":9,"do":"react","emoji":"😍"}]}' });
  await off.b.session(); assert.strictEqual(off.calls.react.length, 0);
  const capped = bot({ posters, cfg: { reactCap: 0 }, answer: '{"items":[{"n":1,"interest":9,"do":"react","emoji":"😍"}]}' });
  await capped.b.session(); assert.strictEqual(capped.calls.react.length, 0);
  const many = Array.from({ length: 12 }, (_, i) => ({ jid: "p" + i, number: "" + i, name: "P" + i, items: items(1, "hi") }));
  const lim = bot({ posters: many, cfg: { dailyPosters: 2 } });
  await lim.b.session(); await lim.b.session(); await lim.b.session();
  assert.ok(lim.b.state.today.posters <= 2, `opened ${lim.b.state.today.posters}`);
});

test("she never watches the same status twice", async () => {
  const posters = [{ jid: "c", number: "300", name: "F", items: items(1, "hello") }];
  const { b, calls } = bot({ posters });
  await b.session(); await b.session();
  assert.strictEqual(calls.view.length, 1);
});

test("tick: waits before the first look, stays quiet at night, and does nothing when switched off", async () => {
  const posters = [{ jid: "c", number: "300", name: "F", items: items(1, "hello") }];
  const { b, calls, setClock } = bot({ posters });
  assert.strictEqual(await b.tick(), false); assert.strictEqual(calls.view.length, 0, "first tick only plans");
  setClock(b.state.nextAt + 1000);
  assert.strictEqual(await b.tick(), true); assert.strictEqual(calls.view.length, 1);
  const night = bot({ posters }); night.setClock(Date.UTC(2026, 9, 13, 7, 0)); // 3am in New York
  night.b.state.nextAt = 1; assert.strictEqual(await night.b.tick(), false);
});
