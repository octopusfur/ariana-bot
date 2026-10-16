"use strict";
// The "Her life" dashboard screen: render with real-looking data, and check that the buttons send the right patches.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const src = html.slice(html.indexOf("/* ---------- HER LIFE (dashboard controls) ---------- */"), html.indexOf("</script>", html.indexOf("/* ---------- HER LIFE (dashboard controls) ---------- */")));

function harness(data) {
  const calls = [], toasts = [];
  const el = { innerHTML: "" };
  const ctx = {
    document: { getElementById: () => el },
    authH: () => ({}), toast: (m) => toasts.push(m), escHTML: (s) => String(s).replace(/</g, "&lt;"),
    confirm: () => true, console,
    fetch: async () => ({ status: 200, json: async () => data }),
    jpost: async (url, body) => { calls.push({ url, body }); return { ok: true, status: 200, d: { ok: true, controls: data.controls } }; },
    Date, Math, JSON, Number, String, Array, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, el, calls, toasts };
}

const DATA = {
  ok: true,
  controls: {
    status: { enabled: true, postsMin: 2, postsMax: 3, kinds: { text: true, photo: true, found: true }, topics: { funny: true, news: true }, telegramStory: true },
    photos: { enabled: true, cooldownMin: 5, dailyCap: 5, sendToOthers: true, othersDailyCap: 6 },
    memory: { autoApprove: true },
    persona: { ownerImmersion: true },
  },
  info: { statusReady: true, searchAvailable: true, telegramLinked: true, pictures: 4, today: [{ at: Date.now(), done: true }], recent: [{ kind: "photo", at: Date.now(), text: "so this is me <today>" }] },
};

test("the screen shows every control, the plan and recent posts, and escapes text", async () => {
  const h = harness(DATA);
  await h.ctx.loadLife();
  for (const word of ["Post to her status", "Her own pictures", "Things she finds online", "Telegram story", "Let her send her pictures", "Wait between pictures", "other people she knows", "Learn from chats automatically", "Stay fully in character with me", "dev:", "Reset everything"]) assert.ok(h.el.innerHTML.includes(word), word);
  assert.ok(h.el.innerHTML.includes("4 in library"));
  assert.ok(h.el.innerHTML.includes("so this is me &lt;today>"), "post text is escaped");
});

test("missing web search / Telegram are explained and their switches are disabled", async () => {
  const d = JSON.parse(JSON.stringify(DATA)); d.info.searchAvailable = false; d.info.telegramLinked = false;
  const h = harness(d);
  await h.ctx.loadLife();
  assert.ok(h.el.innerHTML.includes("FIRECRAWL_API_KEY"));
  assert.ok(h.el.innerHTML.includes("Telegram is not linked"));
  assert.ok(/class="lf-btn" onclick="lifePost\('found','funny'\)" disabled/.test(h.el.innerHTML));
});

test("switches and steppers send exactly the one setting that changed", async () => {
  const h = harness(DATA);
  await h.ctx.loadLife();
  await h.ctx.lifeSet("status.kinds.found", false);
  await h.ctx.lifeSet("photos.cooldownMin", 15);
  await h.ctx.lifeSet("memory.autoApprove", false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.calls.map((c) => c.body))), [{ status: { kinds: { found: false } } }, { photos: { cooldownMin: 15 } }, { memory: { autoApprove: false } }]);
  assert.ok(h.calls.every((c) => c.url === "/api/controls"));
});

test("post-now buttons ask for the right kind", async () => {
  const h = harness(DATA);
  await h.ctx.loadLife();
  await h.ctx.lifePost("found", "news");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.calls.pop())), { url: "/api/whatsapp/status-post", body: { kind: "found", topic: "news" } });
});

test("a wrong dashboard key shows a helpful message instead of breaking", async () => {
  const h = harness(DATA);
  h.ctx.fetch = async () => ({ status: 401, json: async () => ({}) });
  await h.ctx.loadLife();
  assert.ok(h.el.innerHTML.includes("dashboard key"));
});
