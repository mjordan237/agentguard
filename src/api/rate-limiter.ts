import { openSqliteDatabase, type SqliteDatabase } from "../storage/sqlite.js";

export interface RateLimiterOptions {
  /** When set, rate-limit windows are shared through this SQLite file. */
  persistencePath?: string;
}

interface StoredWindow {
  window_start_ms: number;
  request_count: number;
}

/** Fixed-window rate limiter with optional SQLite-backed windows. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();
  private readonly database?: SqliteDatabase;

  constructor(private readonly maxRequests: number, private readonly windowMs: number, options: RateLimiterOptions = {}) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
      throw new Error("Rate limiter maxRequests must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error("Rate limiter windowMs must be a positive safe integer.");
    }
    if (!options.persistencePath) return;
    this.database = openSqliteDatabase(options.persistencePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_windows (
        rate_limit_key TEXT PRIMARY KEY,
        window_start_ms INTEGER NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS rate_limit_windows_window_start_ms
        ON rate_limit_windows (window_start_ms);
    `);
  }

  /** Returns true if the request is allowed, false if the key has already hit the limit for the current window. */
  allow(key: string): boolean {
    const now = Date.now();
    if (this.database) return this.allowPersisted(key, now);
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.maxRequests) return false;
    entry.count += 1;
    return true;
  }

  private allowPersisted(key: string, now: number): boolean {
    let transactionStarted = false;
    try {
      this.database!.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      this.database!.prepare("DELETE FROM rate_limit_windows WHERE window_start_ms <= ?").run(now - this.windowMs);
      const entry = this.database!.prepare(`
        SELECT window_start_ms, request_count FROM rate_limit_windows
        WHERE rate_limit_key = ?
      `).get(key) as StoredWindow | undefined;
      let allowed: boolean;
      if (!entry) {
        this.database!.prepare(`
          INSERT INTO rate_limit_windows (rate_limit_key, window_start_ms, request_count)
          VALUES (?, ?, ?)
        `).run(key, now, 1);
        allowed = true;
      } else if (entry.request_count >= this.maxRequests) {
        allowed = false;
      } else {
        this.database!.prepare(`
          UPDATE rate_limit_windows SET request_count = request_count + 1
          WHERE rate_limit_key = ?
        `).run(key);
        allowed = true;
      }
      this.database!.exec("COMMIT;");
      transactionStarted = false;
      return allowed;
    } catch (error) {
      if (transactionStarted) this.database!.exec("ROLLBACK;");
      throw error;
    }
  }
}
