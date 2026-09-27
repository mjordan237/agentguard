/**
 * Tracks approved spend per policy per asset per UTC day, in memory.
 * Hackathon-scale: resets on process restart, not persisted. A real
 * deployment would back this with a database keyed the same way.
 */
export class DailySpendTracker {
  private readonly spent = new Map<string, bigint>();

  private key(policyId: string, asset: string, date: string): string {
    return `${policyId}:${asset}:${date}`;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  spentToday(policyId: string): Record<string, bigint> {
    const date = this.today();
    const result: Record<string, bigint> = {};
    for (const [key, amount] of this.spent.entries()) {
      const [entryPolicyId, asset, entryDate] = key.split(":");
      if (entryPolicyId === policyId && entryDate === date) result[asset] = amount;
    }
    return result;
  }

  /** Only call this for transactions that were actually ALLOWed -- a NEEDS_REVIEW shouldn't count against the daily budget. */
  record(policyId: string, amountsByAsset: Record<string, bigint>): void {
    const date = this.today();
    for (const [asset, amount] of Object.entries(amountsByAsset)) {
      const key = this.key(policyId, asset, date);
      this.spent.set(key, (this.spent.get(key) ?? 0n) + amount);
    }
  }
}
