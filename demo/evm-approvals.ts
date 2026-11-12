/**
 * EVM demo: the agent is asked to approve USDC spending. The first approval is a
 * bounded amount to a listed vendor; the second is the classic "unlimited approval"
 * to a spender nobody listed. Same policy, same code path as the API.
 * Expect ALLOW, then NEEDS_REVIEW.
 */
import { decodeEvmTransaction, type EvmTransaction } from "../src/evm/decode.js";
import { evaluateEvmTransaction } from "../src/evm/evaluate.js";
import { parsePolicy } from "../src/policy/validate.js";

const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const attacker = "0x3333333333333333333333333333333333333333";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MAX = (1n << 256n) - 1n;

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (a: string) => a.slice(2).padStart(64, "0");
const approve = (spender: string, amount: bigint): EvmTransaction =>
  ({ chainId: 1, from: agent, to: usdc, data: `0x095ea7b3${addr(spender)}${word(amount)}` });

const policy = parsePolicy({
  policyId: "evm-demo",
  programAllowlist: [usdc],
  destinationAllowlist: [vendor],
  maxAmountPerTransaction: { [usdc]: "1000000000" },
  maxAmountPerDay: { [usdc]: "3000000000" },
  allowedChainIds: [1]
});

function run(title: string, tx: EvmTransaction): void {
  console.log(`=== ${title} ===`);
  const decoded = decodeEvmTransaction(tx);
  console.log("Decoded intent:");
  for (const i of decoded.instructions) {
    console.log(`  ${i.programId} :: ${i.instructionName}`);
    console.log(`    ${JSON.stringify(i.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  const evaluation = evaluateEvmTransaction(tx, policy);
  console.log();
  console.log(`Decision: ${evaluation.decision}`);
  if (evaluation.reasons.length > 0) console.log(`Reasons: ${evaluation.reasons.join(" ")}`);
  console.log();
}

run("EVM: bounded USDC approval to the listed vendor (100 USDC)", approve(vendor, 100_000_000n));
run("EVM: unlimited USDC approval to an unlisted spender", approve(attacker, MAX));
