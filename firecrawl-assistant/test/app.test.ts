import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { SdkError } from "firecrawl";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { validateTargetUrl, isPrivateAddress } from "../src/urlGuard.js";
import { withRetry, isRetryable } from "../src/retry.js";
import { TimeoutError } from "../src/errors.js";
import type { FirecrawlLike } from "../src/service.js";

const baseEnv = { FIRECRAWL_API_KEY: "fc-test", SERVICE_API_KEY: "svc", CRAWL_WAIT_SECONDS: "5", AGENT_WAIT_SECONDS: "5", RATE_LIMIT_PER_MINUTE: "1000" };
const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...baseEnv, ...extra } as NodeJS.ProcessEnv);
const auth = { Authorization: "Bearer svc" };

function mockFc() {
  return {
    search: vi.fn(), scrape: vi.fn(), map: vi.fn(), startCrawl: vi.fn(), getCrawlStatus: vi.fn(),
    getCrawlErrors: vi.fn(), startAgent: vi.fn(), getAgentStatus: vi.fn(),
  } satisfies Record<keyof FirecrawlLike, ReturnType<typeof vi.fn>>;
}

describe("config", () => {
  it("requires a Firecrawl key unless self-hosted", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/FIRECRAWL_API_KEY/);
    expect(() => loadConfig({ FIRECRAWL_API_URL: "http://localhost:3002" } as NodeJS.ProcessEnv)).not.toThrow();
  });
  it("refuses to run in production without SERVICE_API_KEY", () => {
    expect(() => loadConfig({ FIRECRAWL_API_KEY: "fc", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/SERVICE_API_KEY/);
  });
});

describe("url guard", () => {
  const c = { allowedDomains: [], blockedDomains: ["evil.com"] };
  it("accepts normal public URLs and strips the fragment", () => {
    expect(validateTargetUrl("https://example.com/a#x", c)).toBe("https://example.com/a");
  });
  it.each([
    "ftp://example.com", "file:///etc/passwd", "http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest",
    "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "http://intranet/", "http://svc.internal/",
    "https://user:pw@example.com/", "https://example.com:8443/", "not a url", "http://[::ffff:127.0.0.1]/",
  ])("rejects %s", (u) => expect(() => validateTargetUrl(u, c)).toThrow());
  it("applies block and allow lists to subdomains", () => {
    expect(() => validateTargetUrl("https://a.evil.com", c)).toThrow(/blocked/i);
    const allow = { allowedDomains: ["example.com"], blockedDomains: [] };
    expect(validateTargetUrl("https://docs.example.com", allow)).toContain("docs.example.com");
    expect(() => validateTargetUrl("https://other.org", allow)).toThrow(/allow-list/);
  });
  it("classifies private addresses", () => {
    expect(isPrivateAddress("172.20.1.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("fd00::1")).toBe(true);
  });
});

describe("retry", () => {
  const sleep = async () => {};
  it("retries 429/5xx and then succeeds", async () => {
    const f = vi.fn().mockRejectedValueOnce(new SdkError("x", 503)).mockRejectedValueOnce(new SdkError("x", 429)).mockResolvedValue("ok");
    expect(await withRetry(f, { budgetMs: 5000, sleep })).toBe("ok");
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("does not retry 4xx", async () => {
    const f = vi.fn().mockRejectedValue(new SdkError("bad", 400));
    await expect(withRetry(f, { budgetMs: 5000, sleep })).rejects.toThrow("bad");
    expect(f).toHaveBeenCalledTimes(1);
    expect(isRetryable(new SdkError("pay", 402))).toBe(false);
  });
  it("enforces the time budget", async () => {
    await expect(withRetry(() => new Promise(() => {}), { budgetMs: 50, sleep })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("HTTP API", () => {
  let fc: ReturnType<typeof mockFc>;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => { fc = mockFc(); app = createApp(cfg(), fc as unknown as FirecrawlLike); });

  it("health is open; /v1 requires the service key", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
    const r = await request(app).post("/v1/search").send({ query: "x" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
  });

  it("search returns clean markdown results", async () => {
    fc.search.mockResolvedValue({ web: [{ markdown: "# Hi", metadata: { title: "T", sourceURL: "https://a.com", description: "d" } }] });
    const r = await request(app).post("/v1/search").set(auth).send({ query: "firecrawl", limit: 3 });
    expect(r.status).toBe(200);
    expect(r.body.web[0]).toMatchObject({ url: "https://a.com", title: "T", markdown: "# Hi" });
    expect(fc.search).toHaveBeenCalledWith("firecrawl", expect.objectContaining({ limit: 3, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }));
  });

  it("search caps limit and rejects unknown fields", async () => {
    expect((await request(app).post("/v1/search").set(auth).send({ query: "x", limit: 99 })).status).toBe(400);
    expect((await request(app).post("/v1/search").set(auth).send({ query: "x", ignoreRobotsTxt: true })).status).toBe(400);
  });

  it("scrape returns markdown + structured json and passes a json format", async () => {
    fc.scrape.mockResolvedValue({ markdown: "# P", json: { price: 5 }, metadata: { sourceURL: "https://a.com/p", title: "P", statusCode: 200 } });
    const r = await request(app).post("/v1/scrape").set(auth).send({ url: "https://a.com/p", json: { prompt: "get price", schema: { type: "object", properties: { price: { type: "number" } } } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ markdown: "# P", json: { price: 5 }, statusCode: 200 });
    const formats = fc.scrape.mock.calls[0][1].formats;
    expect(formats[0]).toBe("markdown");
    expect(formats[1]).toMatchObject({ type: "json", prompt: "get price" });
  });

  it("scrape blocks private targets before calling Firecrawl", async () => {
    const r = await request(app).post("/v1/scrape").set(auth).send({ url: "http://169.254.169.254/latest/meta-data" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("blocked_target");
    expect(fc.scrape).not.toHaveBeenCalled();
  });

  it("map returns links", async () => {
    fc.map.mockResolvedValue({ links: [{ url: "https://a.com/x", title: "X" }] });
    const r = await request(app).post("/v1/map").set(auth).send({ url: "https://a.com", search: "docs" });
    expect(r.body).toEqual({ count: 1, links: [{ url: "https://a.com/x", title: "X" }] });
    expect(fc.map).toHaveBeenCalledWith("https://a.com/", expect.objectContaining({ search: "docs", limit: 50 }));
  });

  it("crawl always sends a small limit, never ignores robots.txt, and reports robots-blocked pages", async () => {
    fc.startCrawl.mockResolvedValue({ id: "job-12345678", url: "u" });
    fc.getCrawlStatus.mockResolvedValue({ id: "job-12345678", status: "completed", total: 1, completed: 1, data: [{ markdown: "m", metadata: { sourceURL: "https://a.com" } }] });
    fc.getCrawlErrors.mockResolvedValue({ errors: [], robotsBlocked: ["https://a.com/private"] });
    const r = await request(app).post("/v1/crawl").set(auth).send({ url: "https://a.com" });
    expect(r.status).toBe(200);
    expect(r.body.robotsBlocked).toEqual(["https://a.com/private"]);
    const opts = fc.startCrawl.mock.calls[0][1];
    expect(opts.limit).toBe(5);
    expect(opts.maxConcurrency).toBe(2);
    expect(opts).not.toHaveProperty("ignoreRobotsTxt");
    expect((await request(app).post("/v1/crawl").set(auth).send({ url: "https://a.com", limit: 500 })).status).toBe(400);
  });

  it("crawl returns 202 + job id when it does not finish in time, and status can be polled", async () => {
    const slow = createApp(cfg({ CRAWL_WAIT_SECONDS: "1" }), fc as unknown as FirecrawlLike);
    fc.startCrawl.mockResolvedValue({ id: "job-abcdefgh", url: "u" });
    fc.getCrawlStatus.mockResolvedValue({ id: "job-abcdefgh", status: "scraping", total: 3, completed: 1, data: [] });
    const r = await request(slow).post("/v1/crawl").set(auth).send({ url: "https://a.com" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ id: "job-abcdefgh", poll: "/v1/crawl/job-abcdefgh" });
    fc.getCrawlErrors.mockResolvedValue({ errors: [], robotsBlocked: [] });
    expect((await request(slow).get("/v1/crawl/job-abcdefgh").set(auth)).body.status).toBe("scraping");
    expect((await request(slow).get("/v1/crawl/..%2Fadmin").set(auth)).status).toBe(400);
  });

  it("agent passes prompt, schema and a credit cap; returns the result", async () => {
    fc.startAgent.mockResolvedValue({ success: true, id: "agent-1234567" });
    fc.getAgentStatus.mockResolvedValue({ success: true, status: "completed", data: { founders: [] }, creditsUsed: 12 });
    const schema = { type: "object", properties: { founders: { type: "array" } } };
    const r = await request(app).post("/v1/agent").set(auth).send({ prompt: "Find the founders", schema });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "completed", data: { founders: [] }, creditsUsed: 12 });
    expect(fc.startAgent).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Find the founders", schema, maxCredits: 100 }));
    expect((await request(app).post("/v1/agent").set(auth).send({ prompt: "x", maxCredits: 1e6 })).status).toBe(400);
  });

  it("agent validates seed URLs", async () => {
    const r = await request(app).post("/v1/agent").set(auth).send({ prompt: "x", urls: ["http://localhost/admin"] });
    expect(r.status).toBe(400);
    expect(fc.startAgent).not.toHaveBeenCalled();
  });

  it("maps upstream failures to clear errors without leaking secrets", async () => {
    fc.scrape.mockRejectedValue(new SdkError("Insufficient credits", 402));
    const r = await request(app).post("/v1/scrape").set(auth).send({ url: "https://a.com" });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("upstream_out_of_credits");
    expect(JSON.stringify(r.body)).not.toContain("fc-test");
    fc.scrape.mockRejectedValue(new SdkError("nope", 429));
    const limited = createApp(cfg(), fc as unknown as FirecrawlLike);
    expect((await request(limited).post("/v1/scrape").set(auth).send({ url: "https://a.com" })).status).toBe(429);
  });

  it("retries transient upstream errors on scrape", async () => {
    fc.scrape.mockRejectedValueOnce(new SdkError("down", 503)).mockResolvedValue({ markdown: "ok", metadata: {} });
    const r = await request(app).post("/v1/scrape").set(auth).send({ url: "https://a.com" });
    expect(r.status).toBe(200);
    expect(fc.scrape).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry crawl/agent starts (would double-bill)", async () => {
    fc.startCrawl.mockRejectedValue(new SdkError("down", 503));
    expect((await request(app).post("/v1/crawl").set(auth).send({ url: "https://a.com" })).status).toBe(502);
    expect(fc.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("rate limits per caller", async () => {
    const tight = createApp(cfg({ RATE_LIMIT_PER_MINUTE: "2" }), fc as unknown as FirecrawlLike);
    fc.map.mockResolvedValue({ links: [] });
    for (let i = 0; i < 2; i++) expect((await request(tight).post("/v1/map").set(auth).send({ url: "https://a.com" })).status).toBe(200);
    const r = await request(tight).post("/v1/map").set(auth).send({ url: "https://a.com" });
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
  });

  it("returns JSON errors for bad JSON and unknown routes", async () => {
    expect((await request(app).post("/v1/search").set(auth).set("Content-Type", "application/json").send("{bad")).body.error.code).toBe("invalid_json");
    expect((await request(app).get("/nope")).status).toBe(404);
  });
});
