import { parentPort, workerData } from "node:worker_threads";
import { DailySpendTracker } from "../src/policy/daily-spend-tracker.js";

// One "process" reserving against a shared SQLite database through its own connection, released with the others at
// the same instant so the reservations genuinely contend across connections.
const { path, amount, limit, id, gate } = workerData as { path: string; amount: string; limit: string; id: string; gate: SharedArrayBuffer };
const tracker = new DailySpendTracker({ persistencePath: path });
const flag = new Int32Array(gate);
Atomics.add(flag, 1, 1); // ready
Atomics.wait(flag, 0, 0); // until the main thread opens the gate
const reservation = tracker.reserveWithinLimit("p", { native: BigInt(amount) }, { native: BigInt(limit) }, id);
parentPort!.postMessage(reservation ? "reserved" : "refused");
