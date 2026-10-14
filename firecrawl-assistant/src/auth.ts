import { timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Bearer / x-api-key check for callers of THIS service. No-op only in local development with no key set. */
export function requireServiceKey(serviceKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!serviceKey) return next();
    const header = req.get("authorization");
    const supplied = req.get("x-api-key") ?? (header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "");
    if (supplied && timingSafeEqual(digest(supplied), digest(serviceKey))) return next();
    res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid service API key." } });
  };
}
