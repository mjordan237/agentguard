/**
 * Fixed-window rate limiter, in memory. Hackathon-scale: resets on
 * process restart, per-process only (doesn't share state across multiple
 * server instances). A real deployment would back this with Redis or
 * similar so limits hold across restarts and horizontal scaling.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(private readonly maxRequests: number, private readonly windowMs: number) {}

  /** Returns true if the request is allowed, false if the key has already hit the limit for the current window. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.maxRequests) return false;
    entry.count += 1;
    return true;
  }
}
