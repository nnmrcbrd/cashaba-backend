import type { NextFunction, Request, Response } from "express";

interface Entry { count: number; resetAt: number }

export function rateLimit(options: { windowMs: number; max: number }) {
  const entries = new Map<string, Entry>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const current = entries.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : current;
    entry.count += 1;
    entries.set(key, entry);
    if (entries.size > 10_000) {
      for (const [storedKey, stored] of entries) if (stored.resetAt <= now) entries.delete(storedKey);
    }
    res.setHeader("RateLimit-Limit", options.max);
    res.setHeader("RateLimit-Remaining", Math.max(0, options.max - entry.count));
    if (entry.count > options.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ message: "Too many attempts. Please try again later." });
      return;
    }
    next();
  };
}
