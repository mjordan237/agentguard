import { EvaluationLog } from "../src/observability/evaluation-log.js";
import type { PolicyEvaluation } from "../src/policy/types.js";

const [persistencePath, agentId, countText] = process.argv.slice(2);
if (!persistencePath || !agentId || !countText) {
  throw new Error("Usage: persistence-writer <sqlite-path> <agent-id> <count>");
}

const count = Number.parseInt(countText, 10);
if (!Number.isSafeInteger(count) || count <= 0) {
  throw new Error("count must be a positive integer");
}

const evaluation: PolicyEvaluation = {
  decision: "ALLOW",
  reasons: [],
  decoded: {
    feePayer: "concurrent-writer",
    instructions: [
      {
        programId: "system",
        instructionName: "transfer",
        fields: { lamports: 42n },
        mode: "interpolated",
        accounts: [],
        amount: 42n,
        asset: "native"
      }
    ]
  }
};

const log = new EvaluationLog({ persistencePath });
for (let index = 0; index < count; index += 1) {
  log.record(agentId, "concurrent-policy", evaluation);
}
