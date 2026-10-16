"use strict";
const test = require("node:test");
const assert = require("node:assert");
const ig = require("../instagram_publish");

const env = { INSTAGRAM_USER_ID: "1784", INSTAGRAM_ACCESS_TOKEN: "SECRET-TOKEN", INSTAGRAM_GRAPH_BASE: "https://graph.example.test/v24.0" };
const recorder = (script) => { const calls = []; const http = async (o) => { calls.push(o); const r = script(o, calls.length); return { status: r.status || 200, data: r.data }; }; return { calls, http }; };

test("publishes in the documented two steps: container with image_url + caption, then media_publish", async () => {
  const { calls, http } = recorder((o) => o.url.endsWith("/media") ? { data: { id: "C1" } } : o.method === "get" ? { data: { status_code: "FINISHED" } } : { data: { id: "M1" } });
  const out = await ig.publishPhoto({ imageUrl: "https://cdn.example.com/a.jpg", caption: "gym day" }, { env, http });
  assert.deepStrictEqual(out, { id: "M1" });
  assert.strictEqual(calls[0].method, "post");
  assert.strictEqual(calls[0].url, "https://graph.example.test/v24.0/1784/media");
  assert.deepStrictEqual({ image_url: calls[0].data.image_url, caption: calls[0].data.caption }, { image_url: "https://cdn.example.com/a.jpg", caption: "gym day" });
  const last = calls[calls.length - 1];
  assert.strictEqual(last.url, "https://graph.example.test/v24.0/1784/media_publish");
  assert.strictEqual(last.data.creation_id, "C1");
});

test("waits while the container is IN_PROGRESS and fails on ERROR", async () => {
  let polls = 0;
  const a = recorder((o) => o.url.endsWith("/media") ? { data: { id: "C" } } : o.method === "get" ? { data: { status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" } } : { data: { id: "M" } });
  await ig.publishPhoto({ imageUrl: "https://x/a.jpg" }, { env, http: a.http, sleep: async () => {} });
  assert.strictEqual(polls, 3);
  const b = recorder((o) => o.url.endsWith("/media") ? { data: { id: "C" } } : { data: { status_code: "ERROR" } });
  await assert.rejects(ig.publishPhoto({ imageUrl: "https://x/a.jpg" }, { env, http: b.http, sleep: async () => {} }), /ERROR/);
});

test("errors never contain the access token", async () => {
  const { http } = recorder(() => ({ status: 400, data: { error: { message: "Invalid OAuth access token SECRET-TOKEN" } } }));
  await assert.rejects(ig.publishPhoto({ imageUrl: "https://x/a.jpg" }, { env, http }), (e) => /Instagram:/.test(e.message) && !e.message.includes("SECRET-TOKEN"));
});

test("refuses without credentials, or without a public https image", async () => {
  assert.strictEqual(ig.isConfigured({}), false);
  assert.strictEqual(ig.isConfigured(env), true);
  await assert.rejects(ig.publishPhoto({ imageUrl: "https://x/a.jpg" }, { env: {}, http: async () => ({}) }), /not set up/);
  await assert.rejects(ig.publishPhoto({ imageUrl: "http://x/a.jpg" }, { env, http: async () => ({}) }), /https/);
  await assert.rejects(ig.publishPhoto({ imageUrl: "data:image/png;base64,AAAA" }, { env, http: async () => ({}) }), /https/);
});
