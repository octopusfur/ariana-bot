"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fcs = require("../firecrawl_skill");

const fake = (over = {}) => ({
  search: async () => ({ web: [{ title: "T", url: "https://a.com/x", markdown: "page text", metadata: {} }] }),
  scrape: async () => ({ markdown: "# Hello\nbody", metadata: { title: "Hello" } }),
  ...over,
});
const withEnv = (env, fn) => async () => {
  const old = { ...process.env };
  Object.assign(process.env, { FIRECRAWL_API_KEY: "fc-test" }, env);
  fcs._resetBudgetForTest();
  try { await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); fcs._setClientForTest(null); }
};

test("disabled without a key: tools are not offered and calls fail softly", async () => {
  const old = process.env.FIRECRAWL_API_KEY, oldU = process.env.FIRECRAWL_API_URL; delete process.env.FIRECRAWL_API_KEY; delete process.env.FIRECRAWL_API_URL;
  fcs._setClientForTest(null);
  assert.strictEqual(fcs.enabled(), false);
  assert.strictEqual((await fcs.webSearch("x")).ok, false);
  if (old) process.env.FIRECRAWL_API_KEY = old; if (oldU) process.env.FIRECRAWL_API_URL = oldU;
});

test("web_search returns wrapped, untrusted-labelled results", withEnv({}, async () => {
  fcs._setClientForTest(fake());
  const r = await fcs.webSearch("burna boy");
  assert.ok(r.ok);
  assert.match(r.output, /untrusted DATA/);
  assert.match(r.output, /https:\/\/a\.com\/x/);
  assert.match(r.output, /page text/);
}));

test("web_read returns page text; truncates long pages", withEnv({}, async () => {
  fcs._setClientForTest(fake({ scrape: async () => ({ markdown: "x".repeat(9000), metadata: { title: "Big" } }) }));
  const r = await fcs.webRead("https://a.com/big");
  assert.ok(r.ok && r.output.length < 4600 && /truncated/.test(r.output));
}));

test("web_read refuses private / internal / odd URLs before calling Firecrawl", withEnv({}, async () => {
  let called = 0;
  fcs._setClientForTest(fake({ scrape: async () => { called++; return { markdown: "x" }; } }));
  for (const u of ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest", "http://10.1.1.1/", "http://[::ffff:127.0.0.1]/", "ftp://a.com", "file:///etc/passwd", "https://u:p@a.com", "https://a.com:8443/", "http://intranet/", "nonsense"]) {
    assert.strictEqual((await fcs.webRead(u)).ok, false, u);
  }
  assert.strictEqual(called, 0);
}));

test("allow/block lists apply to subdomains", withEnv({ FIRECRAWL_BLOCKED_DOMAINS: "evil.com", FIRECRAWL_ALLOWED_DOMAINS: "good.com,evil.com" }, async () => {
  fcs._setClientForTest(fake());
  assert.strictEqual((await fcs.webRead("https://x.evil.com/")).ok, false);
  assert.strictEqual((await fcs.webRead("https://other.org/")).ok, false);
  assert.strictEqual((await fcs.webRead("https://docs.good.com/")).ok, true);
}));

test("transient errors are retried once; 4xx and 402 are not, and give friendly errors", withEnv({}, async () => {
  let n = 0;
  fcs._setClientForTest(fake({ scrape: async () => { n++; if (n === 1) throw Object.assign(new Error("down"), { status: 503 }); return { markdown: "ok" }; } }));
  assert.ok((await fcs.webRead("https://a.com/")).ok);
  assert.strictEqual(n, 2);
  let m = 0;
  fcs._setClientForTest(fake({ scrape: async () => { m++; throw Object.assign(new Error("pay"), { status: 402 }); } }));
  const r = await fcs.webRead("https://a.com/");
  assert.strictEqual(m, 1);
  assert.match(r.error, /out of credits/);
}));

test("daily cap stops runaway credit use", withEnv({ FIRECRAWL_DAILY_CAP: "2" }, async () => {
  fcs._setClientForTest(fake());
  assert.ok((await fcs.webSearch("a")).ok);
  assert.ok((await fcs.webSearch("b")).ok);
  const r = await fcs.webSearch("c");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /daily/);
}));
