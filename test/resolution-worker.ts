import { parentPort, workerData } from "node:worker_threads";
import { PendingReviewStore } from "../src/escalation/pending-store.js";

// One "process" resolving a review: its own SQLite connection, released at the same instant as the others.
const { path, id, status, name, gate } = workerData as { path: string; id: string; status: "APPROVED" | "DENIED"; name: string; gate: SharedArrayBuffer };
const store = new PendingReviewStore({ persistencePath: path });
const flag = new Int32Array(gate);
Atomics.add(flag, 1, 1); // ready
Atomics.wait(flag, 0, 0); // until the main thread opens the gate
const result = store.resolveOutcome(id, status, { kind: "reviewer", id: name, name });
parentPort!.postMessage(result.outcome);
