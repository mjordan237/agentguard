/**
 * Bounded history. Evaluation history and reviews are written on every request and were never deleted,
 * so a busy deployment fills its volume (measured: ~7.7 KB per request, 7.7 GB per million). This
 * deletes entries older than a retention window, a small batch at a time so the event loop and the
 * database write lock are never held for long.
 */
export interface Prunable {
  pruneBatch(cutoffIso: string, limit: number): number;
}

const BATCH_SIZE = 2_000;

/** Deletes everything older than the window. Resolves with the number of rows deleted. */
export async function pruneOlderThan(stores: Prunable[], retentionMs: number, now = Date.now()): Promise<number> {
  const cutoffIso = new Date(now - retentionMs).toISOString();
  let total = 0;
  for (const store of stores) {
    for (;;) {
      const deleted = store.pruneBatch(cutoffIso, BATCH_SIZE);
      total += deleted;
      if (deleted < BATCH_SIZE) break;
      await new Promise((resolve) => setImmediate(resolve)); // let requests run between batches
    }
  }
  return total;
}

/** Prunes now and then every `intervalMs`. The timer never keeps the process alive. */
export function startRetention(stores: Prunable[], retentionMs: number, intervalMs = 60 * 60_000): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    pruneOlderThan(stores, retentionMs)
      .then((deleted) => { if (deleted > 0) console.log(`Retention: deleted ${deleted} entries older than ${Math.round(retentionMs / 86_400_000)} days.`); })
      .catch((error) => console.error("Retention pass failed:", error))
      .finally(() => { running = false; });
  };
  run();
  setInterval(run, intervalMs).unref();
}
