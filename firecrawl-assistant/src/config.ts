import { z } from "zod";

const list = (v?: string) =>
  (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const int = (def: number, min = 1, max = 1_000_000) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: int(3000, 1, 65535),
  FIRECRAWL_API_KEY: z.string().default(""),
  FIRECRAWL_API_URL: z.string().default(""),
  SERVICE_API_KEY: z.string().default(""),
  ALLOWED_DOMAINS: z.string().default(""),
  BLOCKED_DOMAINS: z.string().default(""),
  MAX_SEARCH_RESULTS: int(5, 1, 20),
  MAX_CRAWL_PAGES: int(10, 1, 100),
  MAX_MAP_LINKS: int(100, 1, 5000),
  REQUEST_TIMEOUT_MS: int(60_000, 1000, 300_000),
  CRAWL_WAIT_SECONDS: int(45, 1, 280),
  AGENT_WAIT_SECONDS: int(45, 1, 280),
  AGENT_MAX_CREDITS: int(100, 1, 100_000),
  RATE_LIMIT_PER_MINUTE: int(30, 1, 10_000),
});

export interface Config {
  isProd: boolean;
  port: number;
  firecrawlApiKey: string;
  firecrawlApiUrl: string;
  serviceApiKey: string;
  allowedDomains: string[];
  blockedDomains: string[];
  maxSearchResults: number;
  maxCrawlPages: number;
  maxMapLinks: number;
  requestTimeoutMs: number;
  crawlWaitSeconds: number;
  agentWaitSeconds: number;
  agentMaxCredits: number;
  rateLimitPerMinute: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  const selfHosted = e.FIRECRAWL_API_URL !== "";
  if (!selfHosted && !e.FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY is required (or set FIRECRAWL_API_URL for a self-hosted instance).");
  }
  const isProd = e.NODE_ENV === "production";
  if (isProd && !e.SERVICE_API_KEY) {
    throw new Error("SERVICE_API_KEY is required in production: this service spends Firecrawl credits.");
  }
  return {
    isProd,
    port: e.PORT,
    firecrawlApiKey: e.FIRECRAWL_API_KEY,
    firecrawlApiUrl: e.FIRECRAWL_API_URL,
    serviceApiKey: e.SERVICE_API_KEY,
    allowedDomains: list(e.ALLOWED_DOMAINS),
    blockedDomains: list(e.BLOCKED_DOMAINS),
    maxSearchResults: e.MAX_SEARCH_RESULTS,
    maxCrawlPages: e.MAX_CRAWL_PAGES,
    maxMapLinks: e.MAX_MAP_LINKS,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    crawlWaitSeconds: e.CRAWL_WAIT_SECONDS,
    agentWaitSeconds: e.AGENT_WAIT_SECONDS,
    agentMaxCredits: e.AGENT_MAX_CREDITS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
  };
}
