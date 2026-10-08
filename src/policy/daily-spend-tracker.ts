import { openSqliteDatabase, type SqliteDatabase } from "../storage/sqlite.js";

export interface DailySpendTrackerOptions {
  /** When set, daily totals are persisted in this SQLite file. */
  persistencePath?: string;
}

interface StoredSpendRow {
  asset: string;
  amount: string;
}

/**
 * Tracks approved spend per policy per asset per UTC day. Persistence is
 * best-effort service accounting, not a reconciled on-chain settlement ledger.
 */
export class DailySpendTracker {
  private readonly spent = new Map<string, bigint>();
  private readonly database?: SqliteDatabase;

  constructor(options: DailySpendTrackerOptions = {}) {
    if (!options.persistencePath) return;
    this.database = openSqliteDatabase(options.persistencePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS daily_spend (
        policy_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        spend_date TEXT NOT NULL,
        amount TEXT NOT NULL,
        PRIMARY KEY (policy_id, asset, spend_date)
      ) STRICT;
    `);
  }

  private key(policyId: string, asset: string, date: string): string {
    return `${policyId}:${asset}:${date}`;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  spentToday(policyId: string): Record<string, bigint> {
    const date = this.today();
    const result: Record<string, bigint> = {};
    if (this.database) {
      const rows = this.database.prepare(`
        SELECT asset, amount FROM daily_spend
        WHERE policy_id = ? AND spend_date = ?
      `).all(policyId, date) as StoredSpendRow[];
      for (const row of rows) result[row.asset] = BigInt(row.amount);
      return result;
    }
    for (const [key, amount] of this.spent.entries()) {
      const [entryPolicyId, asset, entryDate] = key.split(":");
      if (entryPolicyId === policyId && entryDate === date) result[asset] = amount;
    }
    return result;
  }

  /** Only call this for transactions that were actually ALLOWed -- a NEEDS_REVIEW shouldn't count against the daily budget. */
  record(policyId: string, amountsByAsset: Record<string, bigint>): void {
    const date = this.today();
    if (this.database) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        for (const [asset, amount] of Object.entries(amountsByAsset)) {
          const row = this.database.prepare(`
            SELECT amount FROM daily_spend
            WHERE policy_id = ? AND asset = ? AND spend_date = ?
          `).get(policyId, asset, date) as Pick<StoredSpendRow, "amount"> | undefined;
          const nextAmount = (row ? BigInt(row.amount) : 0n) + amount;
          this.database.prepare(`
            INSERT INTO daily_spend (policy_id, asset, spend_date, amount)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (policy_id, asset, spend_date) DO UPDATE SET amount = excluded.amount
          `).run(policyId, asset, date, nextAmount.toString());
        }
        this.database.exec("COMMIT;");
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
      return;
    }
    for (const [asset, amount] of Object.entries(amountsByAsset)) {
      const key = this.key(policyId, asset, date);
      this.spent.set(key, (this.spent.get(key) ?? 0n) + amount);
    }
  }
}
