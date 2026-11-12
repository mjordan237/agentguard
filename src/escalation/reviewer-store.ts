import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openSqliteDatabase, type SqliteDatabase } from "../storage/sqlite.js";

/**
 * Named reviewers for the approve/deny step. Each reviewer holds a personal
 * bearer token, so a resolved review can say who resolved it. Only a SHA-256
 * hash of the token is stored; the token itself is shown once at creation.
 *
 * Tokens are 256 random bits, so a plain SHA-256 (no salt, no slow hash) is
 * sufficient for lookup of high-entropy tokens, and it lets us look a
 * reviewer up by hash. This is a bearer token, not SSO or MFA -- anyone who
 * holds it is that reviewer. See docs/integration-and-operations.md, "Known limitations".
 */
export interface Reviewer {
  id: string;
  name: string;
  createdAt: string;
  revokedAt?: string;
  /** Set for a customer's own reviewer, who can act only on that customer's reviews. Absent for an operator reviewer, who can act on all. */
  customerId?: string;
}

export interface ReviewerStoreOptions {
  /** When set, reviewers are persisted in this SQLite file (shared with the other stores). */
  persistencePath?: string;
}

interface ReviewerRow {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  customer_id: string | null;
}

const TOKEN_PREFIX = "agr_";
const MAX_NAME_LENGTH = 80;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toReviewer(row: ReviewerRow): Reviewer {
  return { id: row.id, name: row.name, createdAt: row.created_at, revokedAt: row.revoked_at ?? undefined, customerId: row.customer_id ?? undefined };
}

export class ReviewerStore {
  private readonly database?: SqliteDatabase;
  private readonly memory = new Map<string, Reviewer & { tokenHash: string }>();

  constructor(options: ReviewerStoreOptions = {}) {
    if (options.persistencePath) {
      this.database = openSqliteDatabase(options.persistencePath);
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS reviewers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        ) STRICT;
      `);
      const columns = this.database.prepare("PRAGMA table_info(reviewers)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "customer_id")) this.database.exec("ALTER TABLE reviewers ADD COLUMN customer_id TEXT;");
    }
  }

  /** Returns the new reviewer and their token. The token cannot be recovered later. */
  create(name: string, customerId?: string): { reviewer: Reviewer; token: string } {
    const cleanName = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!cleanName) throw new Error("Reviewer name must not be empty.");
    if (cleanName.length > MAX_NAME_LENGTH) throw new Error(`Reviewer name must be at most ${MAX_NAME_LENGTH} characters.`);

    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const reviewer: Reviewer = { id: randomUUID(), name: cleanName, createdAt: new Date().toISOString(), customerId };
    if (this.database) {
      this.database.prepare("INSERT INTO reviewers (id, name, token_hash, created_at, revoked_at, customer_id) VALUES (?, ?, ?, ?, NULL, ?)")
        .run(reviewer.id, reviewer.name, hashToken(token), reviewer.createdAt, customerId ?? null);
    } else {
      this.memory.set(reviewer.id, { ...reviewer, tokenHash: hashToken(token) });
    }
    return { reviewer, token };
  }

  /** The reviewer holding this token, or undefined if unknown or revoked. */
  authenticate(token: string | undefined): Reviewer | undefined {
    if (!token || !token.startsWith(TOKEN_PREFIX)) return undefined;
    const tokenHash = hashToken(token);
    if (this.database) {
      const row = this.database.prepare(
        "SELECT id, name, created_at, revoked_at, customer_id FROM reviewers WHERE token_hash = ? AND revoked_at IS NULL"
      ).get(tokenHash) as ReviewerRow | undefined;
      return row ? toReviewer(row) : undefined;
    }
    for (const entry of this.memory.values()) {
      if (entry.tokenHash === tokenHash && !entry.revokedAt) {
        const { tokenHash: _hash, ...reviewer } = entry;
        return reviewer;
      }
    }
    return undefined;
  }

  /** Revokes a reviewer. Returns false if no such active reviewer. Past resolutions keep their attribution. */
  revoke(id: string): boolean {
    const now = new Date().toISOString();
    if (this.database) {
      const result = this.database.prepare("UPDATE reviewers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
      return Number(result.changes) > 0;
    }
    const entry = this.memory.get(id);
    if (!entry || entry.revokedAt) return false;
    entry.revokedAt = now;
    return true;
  }

  list(): Reviewer[] {
    if (this.database) {
      return (this.database.prepare("SELECT id, name, created_at, revoked_at, customer_id FROM reviewers ORDER BY created_at").all() as ReviewerRow[]).map(toReviewer);
    }
    return [...this.memory.values()].map(({ tokenHash: _hash, ...reviewer }) => reviewer);
  }

  /** True when at least one active reviewer exists. Reads the database each call so the CLI can add reviewers to a running server. */
  hasActiveReviewers(): boolean {
    if (this.database) {
      return this.database.prepare("SELECT 1 FROM reviewers WHERE revoked_at IS NULL LIMIT 1").get() !== undefined;
    }
    return [...this.memory.values()].some((entry) => !entry.revokedAt);
  }
}
