# firecrawl-assistant-service

A small Node.js/TypeScript (Express 5) service that wraps the official Firecrawl SDK (`firecrawl@4.46.0`, v2 client)
so an AI assistant can search the web, scrape pages, map sites, crawl a few pages and run Firecrawl Agent.

## Setup
```bash
npm install
cp .env.example .env        # set FIRECRAWL_API_KEY and SERVICE_API_KEY
npm test                    # 37 tests, Firecrawl SDK mocked (no credits used)
npm run dev                 # http://localhost:3000
```
Node 20+ required. `npm run typecheck` runs `tsc --noEmit` against the real SDK types.

## Endpoints (all `/v1/*` need `Authorization: Bearer $SERVICE_API_KEY` or `x-api-key`)
| Method & path | SDK call | Notes |
|---|---|---|
| `POST /v1/search` | `search()` | `withContent` (default true) scrapes each hit to markdown |
| `POST /v1/scrape` | `scrape()` | markdown always; add `json:{prompt,schema}` for structured data |
| `POST /v1/map` | `map()` | URL discovery; optional `search` for relevance ordering |
| `POST /v1/crawl`, `GET /v1/crawl/:id` | `startCrawl()`, `getCrawlStatus()`, `getCrawlErrors()` | hard page cap; 202 + job id if not done in time |
| `POST /v1/agent`, `GET /v1/agent/:id` | `startAgent()`, `getAgentStatus()` | prompt, optional `schema`, `urls`, `effort`; 202 + job id if not done in time |
| `GET /health` | | unauthenticated |

Errors are always `{ "error": { "code", "message", "details?" } }`.

## Safety defaults
- URL validation: http/https only, no credentials, default ports only, no localhost/private/link-local/metadata addresses (incl. IPv4-mapped IPv6). Optional `ALLOWED_DOMAINS` / `BLOCKED_DOMAINS`.
- robots.txt: the service never sends `ignoreRobotsTxt` and rejects unknown request fields, so callers cannot turn it on. Crawl responses list `robotsBlocked` pages.
- Crawl: Firecrawl's own default limit is 10,000 pages, so this service always sends `limit` (default 5, max `MAX_CRAWL_PAGES`), `maxConcurrency: 2`, no external links or subdomains.
- Agent: every run gets `maxCredits` (default and max `AGENT_MAX_CREDITS`).
- Retries (exponential backoff + jitter, inside one time budget) only for search/scrape/map on 429, 5xx and network errors. Crawl/agent *starts* are never retried because a retry could bill a second job.
- In production the service refuses to start without `SERVICE_API_KEY`.

## Vercel
See the notes in the chat answer; short version: `vercel.json` rewrites everything to `api/index.ts`, which re-exports the Express app.
Set `FIRECRAWL_API_KEY`, `SERVICE_API_KEY` and (recommended) `ALLOWED_DOMAINS` in Project Settings, and keep `CRAWL_WAIT_SECONDS` / `AGENT_WAIT_SECONDS` below your plan's function duration limit.
