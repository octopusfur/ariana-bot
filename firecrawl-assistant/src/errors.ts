import { SdkError, JobTimeoutError } from "firecrawl";
import { ZodError } from "zod";

/** An error we deliberately return to the caller. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class TimeoutError extends Error {
  constructor(public ms: number) {
    super(`Operation timed out after ${ms} ms`);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

/** Translate anything thrown by the SDK / our code into a clean HTTP response. Never leaks keys or stacks. */
export function toHttpError(err: unknown): { status: number; body: ErrorBody } {
  const body = (status: number, code: string, message: string, details?: unknown) => ({
    status,
    body: { error: { code, message, ...(details !== undefined ? { details } : {}) } } as ErrorBody,
  });

  if (err instanceof HttpError) return body(err.status, err.code, err.message, err.details);
  if (err instanceof ZodError) {
    return body(400, "invalid_request", "Request validation failed", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  if (err instanceof TimeoutError || err instanceof JobTimeoutError) return body(504, "timeout", (err as Error).message);
  if (err instanceof SdkError) {
    const s = err.status;
    if (s === 401) return body(502, "upstream_auth", "Firecrawl rejected the API key configured on this server.");
    if (s === 402) return body(502, "upstream_out_of_credits", "Firecrawl account is out of credits or payment is required.");
    if (s === 403) return body(403, "forbidden_by_firecrawl", err.message);
    if (s === 404) return body(404, "not_found", err.message);
    if (s === 408) return body(504, "timeout", err.message);
    if (s === 429) return body(429, "upstream_rate_limited", "Firecrawl rate limit reached. Retry later.");
    if (s && s >= 400 && s < 500) return body(400, err.code ?? "upstream_rejected", err.message, err.details);
    return body(502, err.code ?? "upstream_error", err.message || "Firecrawl request failed");
  }
  return body(500, "internal_error", "Unexpected server error");
}
