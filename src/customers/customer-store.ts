import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openSqliteDatabase, type SqliteDatabase } from "../storage/sqlite.js";
import { parsePolicy } from "../policy/validate.js";
import type { Policy } from "../policy/types.js";

/**
 * Customers (tenants) of the hosted service. Each customer holds API keys, owns its policies, and gets
 * its own rate limit and its own view of history. Keys are 256 random bits shown once; only a SHA-256
 * hash is stored (plain SHA-256 is right for high-entropy tokens, as in ReviewerStore).
 */
export interface Customer {
  id: string;
  name: string;
  rateLimitPerMinute: number;
  createdAt: string;
  revokedAt?: string;
  /** Where this customer's escalations are posted. When unset they go to the server-wide webhook, if any. */
  slackWebhookUrl?: string;
}

export interface ApiKeyRecord {
  id: string;
  customerId: string;
  createdAt: string;
  revokedAt?: string;
}

interface CustomerRow { id: string; name: string; rate_limit_per_minute: number; created_at: string; revoked_at: string | null; slack_webhook_url: string | null }

const KEY_PREFIX = "agk_";
const MAX_NAME_LENGTH = 80;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const toCustomer = (row: CustomerRow): Customer => ({
  id: row.id, name: row.name, rateLimitPerMinute: Number(row.rate_limit_per_minute), createdAt: row.created_at, revokedAt: row.revoked_at ?? undefined, slackWebhookUrl: row.slack_webhook_url ?? undefined
});

export class CustomerStore {
  private readonly database: SqliteDatabase;

  /** `persistencePath` omitted gives a private in-memory database (tests). */
  constructor(options: { persistencePath?: string } = {}) {
    this.database = openSqliteDatabase(options.persistencePath ?? ":memory:");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute > 0),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS customer_api_keys (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS customer_policies (
        policy_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        policy_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.database.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "slack_webhook_url")) this.database.exec("ALTER TABLE customers ADD COLUMN slack_webhook_url TEXT;");
  }

  create(name: string, rateLimitPerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE): Customer {
    const cleanName = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!cleanName) throw new Error("Customer name must not be empty.");
    if (cleanName.length > MAX_NAME_LENGTH) throw new Error(`Customer name must be at most ${MAX_NAME_LENGTH} characters.`);
    if (!Number.isSafeInteger(rateLimitPerMinute) || rateLimitPerMinute <= 0) throw new Error("Rate limit must be a positive integer.");
    const customer: Customer = { id: randomUUID(), name: cleanName, rateLimitPerMinute, createdAt: new Date().toISOString() };
    this.database.prepare("INSERT INTO customers (id, name, rate_limit_per_minute, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
      .run(customer.id, customer.name, customer.rateLimitPerMinute, customer.createdAt);
    return customer;
  }

  /** Issues a new API key for an active customer. The key cannot be recovered later. A customer may hold several (rotation). */
  issueKey(customerId: string): { keyId: string; apiKey: string } {
    const customer = this.database.prepare("SELECT revoked_at FROM customers WHERE id = ?").get(customerId) as { revoked_at: string | null } | undefined;
    if (!customer) throw new Error("No such customer.");
    if (customer.revoked_at) throw new Error("Customer is revoked.");
    const apiKey = KEY_PREFIX + randomBytes(32).toString("base64url");
    const keyId = randomUUID();
    this.database.prepare("INSERT INTO customer_api_keys (id, customer_id, key_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
      .run(keyId, customerId, hashKey(apiKey), new Date().toISOString());
    return { keyId, apiKey };
  }

  /** The customer holding this key, or undefined if the key is unknown or revoked or its customer is revoked. */
  authenticate(apiKey: string | undefined): Customer | undefined {
    if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) return undefined;
    const row = this.database.prepare(`
      SELECT c.id, c.name, c.rate_limit_per_minute, c.created_at, c.revoked_at, c.slack_webhook_url
      FROM customer_api_keys k JOIN customers c ON c.id = k.customer_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL AND c.revoked_at IS NULL
    `).get(hashKey(apiKey)) as CustomerRow | undefined;
    return row ? toCustomer(row) : undefined;
  }

  revokeKey(keyId: string): boolean {
    const result = this.database.prepare("UPDATE customer_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), keyId);
    return Number(result.changes) > 0;
  }

  /** Sets (or with undefined clears) where this customer's escalations are posted. Only Slack incoming-webhook URLs are accepted. */
  setSlackWebhook(customerId: string, url: string | undefined): boolean {
    if (url !== undefined && !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(url)) {
      throw new Error("Slack webhook must look like https://hooks.slack.com/services/...");
    }
    const result = this.database.prepare("UPDATE customers SET slack_webhook_url = ? WHERE id = ?").run(url ?? null, customerId);
    return Number(result.changes) > 0;
  }

  /** Revoking a customer stops all of its keys working at once. Its history and policies are kept. */
  revoke(customerId: string): boolean {
    const result = this.database.prepare("UPDATE customers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), customerId);
    return Number(result.changes) > 0;
  }

  list(): Customer[] {
    return (this.database.prepare("SELECT id, name, rate_limit_per_minute, created_at, revoked_at, slack_webhook_url FROM customers ORDER BY created_at").all() as CustomerRow[]).map(toCustomer);
  }

  listKeys(customerId: string): ApiKeyRecord[] {
    return (this.database.prepare("SELECT id, customer_id, created_at, revoked_at FROM customer_api_keys WHERE customer_id = ? ORDER BY created_at").all(customerId) as Array<{ id: string; customer_id: string; created_at: string; revoked_at: string | null }>)
      .map((row) => ({ id: row.id, customerId: row.customer_id, createdAt: row.created_at, revokedAt: row.revoked_at ?? undefined }));
  }

  /**
   * True once ANY customer has ever been created, including revoked ones. The server uses this to decide
   * that API keys are required, so revoking the last customer can never reopen the endpoints to everyone.
   * Reads the database each call so the CLI can onboard a customer while the server runs.
   */
  hasAnyCustomers(): boolean {
    return this.database.prepare("SELECT 1 FROM customers LIMIT 1").get() !== undefined;
  }

  /**
   * The customer with this id only if it exists and is not revoked; otherwise undefined. Used to authorize an
   * explicitly scoped request (a Turnkey guarded wallet) before anything is signed for it: a missing or revoked
   * tenant must fail closed, never fall back to a global policy. Distinct from list(), which includes revoked
   * customers for administrative views.
   */
  getActive(customerId: string): Customer | undefined {
    const row = this.database.prepare(
      "SELECT id, name, rate_limit_per_minute, created_at, revoked_at, slack_webhook_url FROM customers WHERE id = ? AND revoked_at IS NULL"
    ).get(customerId) as CustomerRow | undefined;
    return row ? toCustomer(row) : undefined;
  }

  /** Validates and stores (or replaces) a policy for a customer. A policy id belongs to one customer only. */
  setPolicy(customerId: string, input: unknown): Policy {
    const policy = parsePolicy(input);
    const customer = this.database.prepare("SELECT revoked_at FROM customers WHERE id = ?").get(customerId) as { revoked_at: string | null } | undefined;
    if (!customer) throw new Error("No such customer.");
    const owner = this.database.prepare("SELECT customer_id FROM customer_policies WHERE policy_id = ?").get(policy.policyId) as { customer_id: string } | undefined;
    if (owner && owner.customer_id !== customerId) throw new Error(`Policy id "${policy.policyId}" is already used by another customer.`);
    this.database.prepare("INSERT OR REPLACE INTO customer_policies (policy_id, customer_id, policy_json, updated_at) VALUES (?, ?, ?, ?)")
      .run(policy.policyId, customerId, JSON.stringify(policy), new Date().toISOString());
    return policy;
  }

  /** Only returns the policy if this customer owns it, so one customer can never evaluate against another's policy. */
  getPolicy(customerId: string, policyId: string): Policy | undefined {
    const row = this.database.prepare("SELECT policy_json FROM customer_policies WHERE policy_id = ? AND customer_id = ?").get(policyId, customerId) as { policy_json: string } | undefined;
    return row ? parsePolicy(JSON.parse(row.policy_json)) : undefined;
  }

  listPolicies(customerId: string): Policy[] {
    return (this.database.prepare("SELECT policy_json FROM customer_policies WHERE customer_id = ? ORDER BY policy_id").all(customerId) as Array<{ policy_json: string }>)
      .map((row) => parsePolicy(JSON.parse(row.policy_json)));
  }
}
