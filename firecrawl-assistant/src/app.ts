import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { Firecrawl } from "firecrawl";
import type { Config } from "./config.js";
import { HttpError, toHttpError } from "./errors.js";
import { requireServiceKey } from "./auth.js";
import { rateLimit } from "./rateLimit.js";
import { validateTargetUrl } from "./urlGuard.js";
import { createService, type FirecrawlLike } from "./service.js";

const jsonSchemaObj = z.record(z.string(), z.unknown()).refine((o) => JSON.stringify(o).length <= 20_000, "schema too large (max 20 KB)");
const pathList = z.array(z.string().min(1).max(200)).max(20);
const jobId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "invalid job id");

export function createApp(cfg: Config, fc?: FirecrawlLike) {
  const client: FirecrawlLike = fc ?? new Firecrawl({
    apiKey: cfg.firecrawlApiKey || undefined,
    apiUrl: cfg.firecrawlApiUrl || undefined,
    timeoutMs: cfg.requestTimeoutMs,   // axios-level cap per HTTP call
    maxRetries: 3,                     // SDK retries 502 only (verified in httpClient.ts)
    backoffFactor: 0.5,
  });
  const svc = createService(client, cfg);
  const url = (raw: unknown) => validateTargetUrl(raw, cfg);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const v1 = express.Router();
  v1.use(requireServiceKey(cfg.serviceApiKey), rateLimit(cfg.rateLimitPerMinute));

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

  v1.post("/search", wrap(async (req, res) => {
    const b = z.strictObject({
      query: z.string().trim().min(1).max(400),
      limit: z.number().int().min(1).max(cfg.maxSearchResults).default(Math.min(5, cfg.maxSearchResults)),
      sources: z.array(z.enum(["web", "news"])).min(1).default(["web"]),
      includeDomains: z.array(z.string().min(1).max(253)).max(20).optional(),
      excludeDomains: z.array(z.string().min(1).max(253)).max(20).optional(),
      country: z.string().length(2).optional(),
      withContent: z.boolean().default(true), // true: each hit is scraped to clean markdown (costs more credits)
    }).refine((x) => !(x.includeDomains && x.excludeDomains), "includeDomains and excludeDomains cannot both be set").parse(req.body);
    res.json(await svc.search(b));
  }));

  v1.post("/scrape", wrap(async (req, res) => {
    const b = z.strictObject({
      url: z.string(),
      onlyMainContent: z.boolean().default(true),
      waitFor: z.number().int().min(0).max(10_000).optional(),
      json: z.strictObject({ prompt: z.string().max(2000).optional(), schema: jsonSchemaObj.optional() })
        .refine((j) => j.prompt || j.schema, "json needs a prompt and/or a schema").optional(),
    }).parse(req.body);
    res.json(await svc.scrape({ ...b, url: url(b.url) }));
  }));

  v1.post("/map", wrap(async (req, res) => {
    const b = z.strictObject({
      url: z.string(),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(cfg.maxMapLinks).default(Math.min(50, cfg.maxMapLinks)),
      includeSubdomains: z.boolean().default(false),
      sitemap: z.enum(["include", "only", "skip"]).default("include"),
    }).parse(req.body);
    res.json(await svc.map({ ...b, url: url(b.url) }));
  }));

  v1.post("/crawl", wrap(async (req, res) => {
    const b = z.strictObject({
      url: z.string(),
      limit: z.number().int().min(1).max(cfg.maxCrawlPages).default(Math.min(5, cfg.maxCrawlPages)),
      maxDiscoveryDepth: z.number().int().min(0).max(5).default(2),
      includePaths: pathList.optional(),
      excludePaths: pathList.optional(),
      wait: z.boolean().default(true),
    }).parse(req.body);
    const out = await svc.crawl({ ...b, url: url(b.url) });
    res.status(out.done ? 200 : 202).json(out.done ? out : { status: "scraping", id: out.id, poll: `/v1/crawl/${out.id}` });
  }));

  v1.get("/crawl/:id", wrap(async (req, res) => {
    res.json(await svc.crawlStatus(jobId.parse(req.params.id), cfg.maxCrawlPages));
  }));

  v1.post("/agent", wrap(async (req, res) => {
    const b = z.strictObject({
      prompt: z.string().trim().min(1).max(10_000),
      urls: z.array(z.string()).max(10).optional(),
      schema: jsonSchemaObj.optional(),
      effort: z.enum(["low", "medium", "high"]).optional(),
      maxCredits: z.number().int().min(1).max(cfg.agentMaxCredits).default(cfg.agentMaxCredits),
      wait: z.boolean().default(true),
    }).parse(req.body);
    const out = await svc.agent({ ...b, urls: b.urls?.map(url) });
    res.status(out.done ? 200 : 202).json(out.done ? out : { status: "processing", id: out.id, poll: `/v1/agent/${out.id}` });
  }));

  v1.get("/agent/:id", wrap(async (req, res) => {
    res.json(await svc.agentStatus(jobId.parse(req.params.id)));
  }));

  app.use("/v1", v1);
  app.use((_req, _res, next) => next(new HttpError(404, "not_found", "Route not found")));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) return void res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
    const { status, body } = toHttpError(err);
    if (status >= 500) console.error(`[error] ${body.error.code}: ${body.error.message}`);
    res.status(status).json(body);
  });
  return app;
}
