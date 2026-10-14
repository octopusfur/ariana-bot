import { SdkError } from "firecrawl";
import { TimeoutError } from "./errors.js";

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]);

/** Retry only what is safe and useful: 429, 5xx, and network failures. Never 4xx (bad input, auth, credits). */
export function isRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError) return false; // our own budget is spent
  if (err instanceof SdkError) {
    if (err.status === 429) return true;
    if (err.status !== undefined) return err.status >= 500;
    return NETWORK_CODES.has(err.code ?? "");
  }
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && NETWORK_CODES.has(code);
}

export function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([work(), timeout]).finally(() => clearTimeout(timer));
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Total wall-clock budget across all attempts. */
  budgetMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run an idempotent call with exponential backoff + jitter inside one overall time budget.
 * Use only for read-style calls (search / scrape / map). Do NOT use for crawl or agent starts:
 * a retried start can create (and bill) a second job.
 */
export async function withRetry<T>(work: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.budgetMs;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await withTimeout(work, remaining);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const delay = Math.min(base * 2 ** i + Math.random() * 250, Math.max(0, deadline - Date.now() - 1));
      await sleep(delay);
    }
  }
  throw lastErr ?? new TimeoutError(opts.budgetMs);
}
