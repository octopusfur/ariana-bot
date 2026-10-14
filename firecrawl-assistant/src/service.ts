import type { Firecrawl, Document } from "firecrawl";
import type { Config } from "./config.js";
import { withRetry, withTimeout } from "./retry.js";
import { assertPublicDns } from "./urlGuard.js";

/** The only SDK methods this service uses (all exist on the Firecrawl v2 client in firecrawl@4.46.0). */
export type FirecrawlLike = Pick<
  Firecrawl,
  "search" | "scrape" | "map" | "startCrawl" | "getCrawlStatus" | "getCrawlErrors" | "startAgent" | "getAgentStatus"
>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const slimDoc = (d: Document) => ({
  url: d.metadata?.sourceURL ?? d.metadata?.url,
  title: d.metadata?.title,
  description: d.metadata?.description,
  markdown: d.markdown,
  ...(d.json !== undefined ? { json: d.json } : {}),
});

export function createService(fc: FirecrawlLike, cfg: Config) {
  const budget = cfg.requestTimeoutMs;
  const selfHosted = cfg.firecrawlApiUrl !== "";
  const checkDns = async (url: string) => { if (selfHosted) await assertPublicDns(url); };

  return {
    async search(p: { query: string; limit: number; sources: Array<"web" | "news">; includeDomains?: string[]; excludeDomains?: string[]; country?: string; withContent: boolean }) {
      const data = await withRetry(
        () => fc.search(p.query, {
          limit: p.limit,
          sources: p.sources,
          ...(p.includeDomains ? { includeDomains: p.includeDomains } : {}),
          ...(p.excludeDomains ? { excludeDomains: p.excludeDomains } : {}),
          ...(p.country ? { country: p.country } : {}),
          ...(p.withContent ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
        }),
        { budgetMs: budget },
      );
      const norm = (items: Array<Document | Record<string, any>> = []) => items.map((it) => {
        const r = it as Record<string, any>;
        return "markdown" in r || "metadata" in r
          ? slimDoc(it as Document)
          : { url: r.url, title: r.title, description: r.description };
      });
      return { web: norm(data.web), ...(data.news ? { news: norm(data.news) } : {}), ...(data.warning ? { warning: data.warning } : {}) };
    },

    async scrape(p: { url: string; onlyMainContent: boolean; waitFor?: number; json?: { prompt?: string; schema?: Record<string, unknown> } }) {
      await checkDns(p.url);
      const formats: Array<"markdown" | { type: "json"; prompt?: string; schema?: Record<string, unknown> }> = ["markdown"];
      if (p.json) formats.push({ type: "json", ...(p.json.prompt ? { prompt: p.json.prompt } : {}), ...(p.json.schema ? { schema: p.json.schema } : {}) });
      const doc = await withRetry(
        () => fc.scrape(p.url, { formats, onlyMainContent: p.onlyMainContent, timeout: Math.min(budget, 120_000), ...(p.waitFor ? { waitFor: p.waitFor } : {}) }),
        { budgetMs: budget },
      );
      return { ...slimDoc(doc), url: doc.metadata?.sourceURL ?? p.url, statusCode: doc.metadata?.statusCode, ...(doc.warning ? { warning: doc.warning } : {}) };
    },

    async map(p: { url: string; search?: string; limit: number; includeSubdomains: boolean; sitemap: "include" | "only" | "skip" }) {
      await checkDns(p.url);
      const data = await withRetry(
        () => fc.map(p.url, { limit: p.limit, includeSubdomains: p.includeSubdomains, sitemap: p.sitemap, ...(p.search ? { search: p.search } : {}), timeout: Math.min(budget, 120_000) }),
        { budgetMs: budget },
      );
      return { count: data.links.length, links: data.links };
    },

    /**
     * Start a crawl and wait up to CRAWL_WAIT_SECONDS. If it is still running we return the job id (HTTP 202)
     * so the caller can poll GET /v1/crawl/:id. The start call is NOT retried: a retry could bill a second crawl.
     */
    async crawl(p: { url: string; limit: number; maxDiscoveryDepth: number; includePaths?: string[]; excludePaths?: string[]; wait: boolean }) {
      await checkDns(p.url);
      const started = await withTimeout(
        () => fc.startCrawl(p.url, {
          limit: p.limit,                       // the API's own default is 10000 pages, so we ALWAYS send a small cap
          maxDiscoveryDepth: p.maxDiscoveryDepth,
          includePaths: p.includePaths,
          excludePaths: p.excludePaths,
          allowExternalLinks: false,
          allowSubdomains: false,
          crawlEntireDomain: false,
          ignoreQueryParameters: true,
          maxConcurrency: 2,                    // gentle on the target site
          scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
          // ignoreRobotsTxt is deliberately never sent: Firecrawl's API default (false) respects robots.txt.
        }),
        budget,
      );
      if (!p.wait) return { done: false as const, id: started.id };
      const deadline = Date.now() + cfg.crawlWaitSeconds * 1000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const job = await withRetry(() => fc.getCrawlStatus(started.id, { autoPaginate: true, maxResults: p.limit }), { budgetMs: budget });
        if (job.status !== "scraping") return { done: true as const, ...(await shapeCrawl(fc, job, budget)) };
      }
      return { done: false as const, id: started.id };
    },

    async crawlStatus(id: string, limit: number) {
      const job = await withRetry(() => fc.getCrawlStatus(id, { autoPaginate: true, maxResults: limit }), { budgetMs: budget });
      return shapeCrawl(fc, job, budget);
    },

    /** Start an agent run, then wait up to AGENT_WAIT_SECONDS. Start is not retried (billing). */
    async agent(p: { prompt: string; urls?: string[]; schema?: Record<string, unknown>; effort?: "low" | "medium" | "high"; maxCredits: number; wait: boolean }) {
      if (p.urls) await Promise.all(p.urls.map(checkDns));
      const started = await withTimeout(
        () => fc.startAgent({ prompt: p.prompt, urls: p.urls, schema: p.schema, effort: p.effort, maxCredits: p.maxCredits, strictConstrainToURLs: p.urls ? true : undefined }),
        budget,
      );
      if (!started.success || !started.id) return { done: true as const, status: "failed" as const, error: started.error ?? "Agent did not start" };
      if (!p.wait) return { done: false as const, id: started.id };
      const deadline = Date.now() + cfg.agentWaitSeconds * 1000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const s = await withRetry(() => fc.getAgentStatus(started.id), { budgetMs: budget });
        if (s.status !== "processing") return { done: true as const, id: started.id, ...shapeAgent(s) };
      }
      return { done: false as const, id: started.id };
    },

    async agentStatus(id: string) {
      const s = await withRetry(() => fc.getAgentStatus(id), { budgetMs: budget });
      return { id, ...shapeAgent(s) };
    },
  };
}

async function shapeCrawl(fc: FirecrawlLike, job: Awaited<ReturnType<FirecrawlLike["getCrawlStatus"]>>, budget: number) {
  let robotsBlocked: string[] = [];
  try { robotsBlocked = (await withTimeout(() => fc.getCrawlErrors(job.id), Math.min(budget, 15_000))).robotsBlocked ?? []; } catch { /* best effort */ }
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    creditsUsed: job.creditsUsed,
    robotsBlocked,
    pages: (job.data ?? []).map(slimDoc),
  };
}

function shapeAgent(s: Awaited<ReturnType<FirecrawlLike["getAgentStatus"]>>) {
  return {
    status: s.status,
    ...(s.data !== undefined ? { data: s.data } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.partial !== undefined ? { partial: s.partial } : {}),
    ...(s.creditsUsed !== undefined ? { creditsUsed: s.creditsUsed } : {}),
    ...(s.stopReason ? { stopReason: s.stopReason } : {}),
  };
}
