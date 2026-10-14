import type { Request, Response, NextFunction } from "express";

/**
 * Fixed-window limiter, in memory. Good enough for one process.
 * On Vercel each function instance has its own memory, so treat this as a courtesy and
 * use Vercel WAF / Upstash for a real global limit (see README).
 */
export function rateLimit(perMinute: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = (req.get("x-api-key") ?? req.get("authorization") ?? req.ip ?? "anon").slice(0, 80);
    const t = now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    let e = hits.get(key);
    if (!e || e.resetAt <= t) { e = { count: 0, resetAt: t + 60_000 }; hits.set(key, e); }
    e.count++;
    res.set("X-RateLimit-Limit", String(perMinute));
    res.set("X-RateLimit-Remaining", String(Math.max(0, perMinute - e.count)));
    if (e.count > perMinute) {
      res.set("Retry-After", String(Math.ceil((e.resetAt - t) / 1000)));
      return res.status(429).json({ error: { code: "rate_limited", message: "Too many requests. Slow down." } });
    }
    next();
  };
}
