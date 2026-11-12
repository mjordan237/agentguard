import { randomUUID } from "node:crypto";
import { deserializeStoredValue, openSqliteDatabase, serializeStoredValue, type SqliteDatabase } from "../storage/sqlite.js";

export interface DailySpendTrackerOptions {
  /** When set, daily totals are persisted in this SQLite file. */
  persistencePath?: string;
}

interface StoredSpendRow {
  asset: string;
  amount: string;
}

/**
 * Budget set aside for one transaction, remembering the UTC day it was charged to so a refund goes back to that same
 * day. `id` names the charge: one id holds at most one charge at a time, and refunding it twice refunds it once.
 */
export interface SpendReservation {
  id: string;
  policyId: string;
  date: string;
  amounts: Record<string, bigint>;
}

/**
 * Tracks approved spend per policy per asset per UTC day. Persistence is
 * best-effort service accounting, not a reconciled on-chain settlement ledger.
 */
export class DailySpendTracker {
  private readonly spent = new Map<string, bigint>();
  /** In-memory reservations: id to the charge and whether it is still held. */
  private readonly reservations = new Map<string, { reservation: SpendReservation; held: boolean }>();
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
      CREATE TABLE IF NOT EXISTS spend_reservations (
        id TEXT PRIMARY KEY,
        reservation_json TEXT NOT NULL,
        spend_date TEXT NOT NULL,
        held INTEGER NOT NULL
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
      // Policy ids and dates contain no colon, but an asset name may ("evm:gas"), so split at the first and last one.
      const first = key.indexOf(":");
      const last = key.lastIndexOf(":");
      const entryPolicyId = key.slice(0, first);
      const asset = key.slice(first + 1, last);
      const entryDate = key.slice(last + 1);
      if (entryPolicyId === policyId && entryDate === date) result[asset] = amount;
    }
    return result;
  }

  /**
   * Charges a transaction to today. Only call this for transactions that were actually ALLOWed -- a NEEDS_REVIEW
   * shouldn't count against the daily budget. With an `id` that already holds a charge, nothing more is charged and
   * that charge is returned: a retry after a crash cannot charge the same thing twice. The check and the charge are
   * one transaction.
   */
  record(policyId: string, amountsByAsset: Record<string, bigint>, id: string = randomUUID()): SpendReservation {
    const reservation: SpendReservation = { id, policyId, date: this.today(), amounts: amountsByAsset };
    if (this.database) {
      return this.inTransaction(() => {
        const existing = this.heldWithin(id);
        if (existing) return existing;
        this.adjustWithin(policyId, amountsByAsset, 1n, reservation.date);
        this.database!.prepare(`
          INSERT INTO spend_reservations (id, reservation_json, spend_date, held) VALUES (?, ?, ?, 1)
          ON CONFLICT (id) DO UPDATE SET reservation_json = excluded.reservation_json, spend_date = excluded.spend_date, held = 1
        `).run(id, serializeStoredValue(reservation), reservation.date);
        return reservation;
      });
    }
    const existing = this.reservations.get(id);
    if (existing?.held) return existing.reservation;
    this.adjustMemory(policyId, amountsByAsset, 1n, reservation.date);
    this.reservations.set(id, { reservation, held: true });
    return reservation;
  }

  /**
   * Reserves `amountsByAsset` only if, for every asset that has a configured daily limit, the day's total after this
   * reservation stays within that limit. The read of the current total, the limit check and the write all happen in
   * one BEGIN IMMEDIATE transaction, so two requests (even on separate SQLite connections) cannot both pass against
   * the same earlier total and together exceed the limit. Returns the reservation, or null if it would exceed a
   * limit (nothing is reserved then). Idempotent by id, like record(): a held id returns its reservation unchanged.
   * Assets without a configured daily limit are not capped here, exactly as evaluatePolicy does not cap them.
   */
  reserveWithinLimit(policyId: string, amountsByAsset: Record<string, bigint>, dailyLimits: Record<string, bigint>, id: string = randomUUID()): SpendReservation | null {
    const reservation: SpendReservation = { id, policyId, date: this.today(), amounts: amountsByAsset };
    const withinLimit = (current: Record<string, bigint>): boolean => {
      for (const [asset, amount] of Object.entries(amountsByAsset)) {
        const limit = dailyLimits[asset];
        if (limit !== undefined && (current[asset] ?? 0n) + amount > limit) return false;
      }
      return true;
    };
    if (this.database) {
      return this.inTransaction(() => {
        const existing = this.heldWithin(id);
        if (existing) return existing;
        if (!withinLimit(this.spentToday(policyId))) return null;
        this.adjustWithin(policyId, amountsByAsset, 1n, reservation.date);
        this.database!.prepare(`
          INSERT INTO spend_reservations (id, reservation_json, spend_date, held) VALUES (?, ?, ?, 1)
          ON CONFLICT (id) DO UPDATE SET reservation_json = excluded.reservation_json, spend_date = excluded.spend_date, held = 1
        `).run(id, serializeStoredValue(reservation), reservation.date);
        return reservation;
      });
    }
    const existing = this.reservations.get(id);
    if (existing?.held) return existing.reservation;
    if (!withinLimit(this.spentToday(policyId))) return null;
    this.adjustMemory(policyId, amountsByAsset, 1n, reservation.date);
    this.reservations.set(id, { reservation, held: true });
    return reservation;
  }

  /** The charge `id` still holds, if any. */
  held(id: string): SpendReservation | undefined {
    if (this.database) return this.heldWithin(id);
    const entry = this.reservations.get(id);
    return entry?.held ? entry.reservation : undefined;
  }

  /**
   * Gives back a reservation for a transaction that provably never went out. It is refunded to the day it
   * was charged to, not to today: refunding it to a later day would erase real spend from that day and let
   * its cap be exceeded. Refunds the amount recorded with the charge, once: releasing an id that was already
   * released, or never charged, does nothing. Never goes below zero.
   */
  release(reservation: SpendReservation): void {
    if (this.database) {
      this.inTransaction(() => {
        const stored = this.heldWithin(reservation.id);
        if (!stored) return;
        this.adjustWithin(stored.policyId, stored.amounts, -1n, stored.date);
        this.database!.prepare("UPDATE spend_reservations SET held = 0 WHERE id = ?").run(reservation.id);
      });
      return;
    }
    const entry = this.reservations.get(reservation.id);
    if (!entry?.held) return;
    this.adjustMemory(entry.reservation.policyId, entry.reservation.amounts, -1n, entry.reservation.date);
    entry.held = false;
  }

  /** Retention: forgets reservations charged to a day before the cutoff. The daily totals are not touched. */
  pruneBatch(cutoffIso: string, limit: number): number {
    const day = cutoffIso.slice(0, 10);
    if (this.database) {
      return Number(this.database.prepare("DELETE FROM spend_reservations WHERE rowid IN (SELECT rowid FROM spend_reservations WHERE spend_date < ? LIMIT ?)").run(day, limit).changes);
    }
    let removed = 0;
    for (const [id, entry] of this.reservations) {
      if (removed >= limit) break;
      if (entry.reservation.date < day) { this.reservations.delete(id); removed++; }
    }
    return removed;
  }

  private heldWithin(id: string): SpendReservation | undefined {
    const row = this.database!.prepare("SELECT reservation_json FROM spend_reservations WHERE id = ? AND held = 1").get(id) as { reservation_json: string } | undefined;
    return row ? deserializeStoredValue<SpendReservation>(row.reservation_json) : undefined;
  }

  private inTransaction<T>(work: () => T): T {
    this.database!.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.database!.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database!.exec("ROLLBACK;");
      throw error;
    }
  }

  private adjustWithin(policyId: string, amountsByAsset: Record<string, bigint>, sign: 1n | -1n, date: string): void {
    for (const [asset, amount] of Object.entries(amountsByAsset)) {
      const row = this.database!.prepare(`
        SELECT amount FROM daily_spend
        WHERE policy_id = ? AND asset = ? AND spend_date = ?
      `).get(policyId, asset, date) as Pick<StoredSpendRow, "amount"> | undefined;
      const nextAmount = applyChange(row ? BigInt(row.amount) : 0n, amount, sign);
      this.database!.prepare(`
        INSERT INTO daily_spend (policy_id, asset, spend_date, amount)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (policy_id, asset, spend_date) DO UPDATE SET amount = excluded.amount
      `).run(policyId, asset, date, nextAmount.toString());
    }
  }

  private adjustMemory(policyId: string, amountsByAsset: Record<string, bigint>, sign: 1n | -1n, date: string): void {
    for (const [asset, amount] of Object.entries(amountsByAsset)) {
      const key = this.key(policyId, asset, date);
      this.spent.set(key, applyChange(this.spent.get(key) ?? 0n, amount, sign));
    }
  }
}

function applyChange(current: bigint, amount: bigint, sign: 1n | -1n): bigint {
  const next = current + sign * amount;
  return next < 0n ? 0n : next;
}
