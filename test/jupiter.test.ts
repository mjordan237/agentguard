import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { registerStandardPrograms, TOKEN_PROGRAM } from "../src/agent-integration/standard-programs.js";
import { ASSOCIATED_TOKEN_PROGRAM } from "../src/agent-integration/payment-extras.js";
import { JUPITER_V6_PROGRAM } from "../src/agent-integration/jupiter.js";
import { WRAPPED_SOL_MINT } from "../src/policy/swap-rules.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { parsePolicy } from "../src/policy/validate.js";
import { buildDemoRegistry } from "../demo/policy.js";
import type { Policy } from "../src/policy/types.js";

import { USDC, JUP, discriminator, ata, sellSol, type Built } from "./jupiter-builders.js";

const registry = registerStandardPrograms(buildDemoRegistry());

const policy = (overrides: Partial<Policy> = {}): Policy => parsePolicy({
  policyId: "swaps",
  programAllowlist: [JUPITER_V6_PROGRAM, SystemProgram.programId.toBase58(), TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM],
  destinationAllowlist: [Keypair.generate().publicKey.toBase58()],
  maxAmountPerTransaction: { native: "2000000000" },
  maxAmountPerDay: { native: "10000000000" },
  swapPairs: [{ inputMint: "native", outputMint: USDC, minOutPerIn: "0.14" }],
  maxSlippageBps: 100,
  ...overrides
});

async function evaluate(built: Built, p: Policy = policy()) {
  const message = new TransactionMessage({ payerKey: built.agent, recentBlockhash: PublicKey.default.toBase58(), instructions: built.instructions }).compileToV0Message();
  const decoded = await parseAndDecodeTransaction(Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), registry);
  return evaluatePolicy(decoded, p);
}

test("the pinned Jupiter IDL is the one fetched from chain", () => {
  const bytes = readFileSync(new URL("../../src/agent-integration/idl/jupiter-v6.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "e6c2b425ec740922ee91aa7a3278cea07f4bc00a3ed9efa4eca16facb481bfca");
});

test("a v2 SOL to USDC swap within policy, with its wrap and unwrap, is ALLOWed and counted once as SOL", async () => {
  const result = await evaluate(sellSol());
  assert.equal(result.decision, "ALLOW", result.reasons.join("\n"));
  assert.deepEqual(result.spend, { native: 1_000_000_000n }, "the wrap transfer is not counted again");
});

test("a legacy route, which names no source mint, is matched to the policy's input mint and ALLOWed", async () => {
  const result = await evaluate(sellSol({ legacy: true }));
  assert.equal(result.decision, "ALLOW", result.reasons.join("\n"));
  assert.deepEqual(result.spend, { native: 1_000_000_000n });
});

const cases: Array<[string, () => Built, RegExp, Partial<Policy>?]> = [
  ["output to someone else", () => sellSol({ destination: ata(Keypair.generate().publicKey, USDC) }), /neither the signer's own token account/],
  ["output to someone else (legacy)", () => sellSol({ legacy: true, destination: ata(Keypair.generate().publicKey, USDC) }), /neither the signer's own token account/],
  ["a pair the policy does not list", () => sellSol(), /not a pair the policy allows/, { swapPairs: [{ inputMint: USDC, outputMint: "native" }] }],
  ["no swap pairs at all", () => sellSol(), /lists no swap pairs/, { swapPairs: undefined }],
  ["slippage above the cap", () => sellSol({ args: { slippageBps: 500 } }), /Slippage tolerance 500 bps exceeds/],
  ["no slippage cap", () => sellSol(), /no maxSlippageBps/, { maxSlippageBps: undefined }],
  ["a zero quote", () => sellSol({ args: { quotedOut: 0n } }), /quoted output is zero/],
  ["a price below the floor", () => sellSol({ args: { quotedOut: 100_000_000n } }), /below the policy's floor/],
  ["a platform fee", () => sellSol({ args: { platformFeeBps: 20 } }), /platform fee of 20 bps/],
  ["a v2 platform fee within the cap, whose recipient cannot be seen", () => sellSol({ args: { platformFeeBps: 20 } }), /names no fee account/, { maxPlatformFeeBps: 50 }],
  ["positive slippage kept as a fee", () => sellSol({ args: { positiveSlippageBps: 10 } }), /above the quote/],
  ["more than the per-transaction cap", () => sellSol({ args: { inAmount: 3_000_000_000n } }), /exceeds the per-transaction limit/],
  ["trailing bytes after the arguments", () => sellSol({ args: { trailing: Buffer.from([0]) } }), /follow the arguments/],
  ["trailing bytes after the arguments (legacy)", () => sellSol({ legacy: true, args: { trailing: Buffer.from([0, 0]) } }), /follow the arguments/],
  ["a route plan that does not add up", () => sellSol({ args: { shares: [6_000, 3_000] } }), /add up to 9000 of 10000/],
  ["an unknown swap variant", () => sellSol({ args: { variant: 250 } }), /has no variant 250/],
  ["wrapping SOL into someone else's account", () => sellSol({ wrapTo: ata(Keypair.generate().publicKey, WRAPPED_SOL_MINT) }), /not in the allowlist/],
  ["unwrapping to someone else", () => sellSol({ closeTo: Keypair.generate().publicKey }), /not in the allowlist/]
];

for (const [name, build, why, overrides] of cases) {
  test(`swap goes to review: ${name}`, async () => {
    const result = await evaluate(build(), policy(overrides));
    assert.equal(result.decision, "NEEDS_REVIEW");
    assert.ok(result.reasons.some((reason) => why.test(reason)), `expected ${why} in:\n${result.reasons.join("\n")}`);
  });
}

test("a truncated route plan and a token-ledger or exact-out route go to review with a reason", async () => {
  const built = sellSol();
  const swap = built.instructions[4]!;
  for (const [data, why] of [
    [swap.data.subarray(0, swap.data.length - 3), /could not be read/],
    [Buffer.concat([discriminator("route_with_token_ledger"), Buffer.alloc(16)]), /ledger account at run time/],
    [Buffer.concat([discriminator("exact_out_route_v2"), Buffer.alloc(16)]), /Exact-out routes are not supported/]
  ] as const) {
    built.instructions[4] = new TransactionInstruction({ programId: JUP, keys: swap.keys, data: Buffer.from(data) });
    const result = await evaluate(built);
    assert.equal(result.decision, "NEEDS_REVIEW");
    assert.ok(result.reasons.some((reason) => why.test(reason)), `expected ${why} in:\n${result.reasons.join("\n")}`);
  }
});

test("random corruption of a valid swap never turns review into a different ALLOW", async () => {
  let seed = 4242;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const p = policy();
  for (let i = 0; i < 300; i++) {
    const built = sellSol();
    const swap = built.instructions[4]!;
    const data = Buffer.from(swap.data);
    data[8 + Math.floor(random() * (data.length - 8))] ^= 1 << Math.floor(random() * 8);
    built.instructions[4] = new TransactionInstruction({ programId: JUP, keys: swap.keys, data });
    const result = await evaluate(built, p);
    if (result.decision !== "ALLOW") continue;
    // Anything still ALLOWed must still satisfy every rule on its own terms.
    const s = result.decoded.instructions[4]!.swap!;
    assert.ok(s.inAmount <= 2_000_000_000n && s.slippageBps <= 100 && s.quotedOutAmount > 0n && s.platformFeeBps === 0 && s.positiveSlippageBps === 0);
    assert.ok((s.quotedOutAmount * BigInt(10_000 - s.slippageBps)) / 10_000n * 100n >= s.inAmount * 14n, "price floor held");
  }
});

// Real mainnet swaps, replayed offline. Each lookup table is rebuilt from the addresses the transaction loaded.
interface Fixture { signature: string; kind: string; transactionBase64: string; lookups: { table: string; writableIndexes: number[]; readonlyIndexes: number[] }[]; loadedAddresses: { writable: string[]; readonly: string[] } }
const mainnet = (JSON.parse(readFileSync(new URL("../../test/fixtures/jupiter-mainnet.json", import.meta.url), "utf8")) as { transactions: Fixture[] }).transactions;

async function decodeFixture(fixture: Fixture, replace?: [string, string]) {
  const swapKey = (key: string) => (replace && key === replace[0] ? replace[1] : key);
  const writable = fixture.loadedAddresses.writable.map(swapKey), readonly = fixture.loadedAddresses.readonly.map(swapKey);
  const tables = new Map<string, PublicKey[]>();
  for (const lookup of fixture.lookups) {
    const size = Math.max(-1, ...lookup.writableIndexes, ...lookup.readonlyIndexes) + 1;
    const addresses = Array.from({ length: size }, () => Keypair.generate().publicKey);
    for (const index of lookup.writableIndexes) addresses[index] = new PublicKey(writable.shift()!);
    for (const index of lookup.readonlyIndexes) addresses[index] = new PublicKey(readonly.shift()!);
    tables.set(lookup.table, addresses);
  }
  let transaction = fixture.transactionBase64;
  if (replace) {
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    const keys = tx.message.staticAccountKeys;
    keys.forEach((key, index) => { if (key.toBase58() === replace[0]) keys[index] = new PublicKey(replace[1]); });
    transaction = Buffer.from(tx.serialize()).toString("base64");
  }
  const { AddressLookupTableAccount } = await import("@solana/web3.js");
  return parseAndDecodeTransaction(transaction, registry, async (key) => {
    const addresses = tables.get(key.toBase58());
    return addresses ? new AddressLookupTableAccount({ key, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses } }) : null;
  });
}

/** A policy that allows exactly this swap: its programs, its pair, its slippage, its amount. */
function fittedPolicy(decoded: Awaited<ReturnType<typeof decodeFixture>>, inputMint: string): Policy {
  const swap = decoded.instructions.find((instruction) => instruction.swap)!.swap!;
  const asset = inputMint === WRAPPED_SOL_MINT ? "native" : inputMint;
  return parsePolicy({
    policyId: "fitted",
    programAllowlist: [...new Set(decoded.instructions.map((instruction) => instruction.programId))],
    destinationAllowlist: [],
    maxAmountPerTransaction: { [asset]: String(swap.inAmount) },
    maxAmountPerDay: { [asset]: String(swap.inAmount) },
    swapPairs: [{ inputMint, outputMint: swap.destinationMint }],
    maxSlippageBps: swap.slippageBps,
    maxPriorityFeePerTransaction: String(decoded.priorityFee ?? 0n)
  });
}

// Input mints read from chain: legacy `route` does not name its source mint.
const INPUT_MINT: Record<string, string> = {
  "4dq1hPE8wE": "7SL2VnfYsChvog5oQY9Nmtqu1wceaMiQzWoqoLQpump",
  "51rcXMLDpn": WRAPPED_SOL_MINT,
  "52F9mVM15N": WRAPPED_SOL_MINT,
  "3Lv8ePBTdS": WRAPPED_SOL_MINT
};

for (const fixture of mainnet) {
  const inputMint = INPUT_MINT[fixture.signature.slice(0, 10)]!;
  test(`mainnet ${fixture.kind} ${fixture.signature.slice(0, 10)} decodes fully and is judged on its own terms`, async () => {
    const decoded = await decodeFixture(fixture);
    const swap = decoded.instructions.find((instruction) => instruction.swap);
    assert.ok(swap, "the swap is decoded");
    assert.equal(swap.instructionName, fixture.kind);
    const result = evaluatePolicy(decoded, fittedPolicy(decoded, inputMint));
    if (swap.swap!.platformFeeBps > 0) {
      assert.equal(result.decision, "NEEDS_REVIEW");
      assert.ok(result.reasons.some((reason) => /platform fee/.test(reason)), result.reasons.join("\n"));
      return;
    }
    assert.equal(result.decision, "ALLOW", result.reasons.join("\n"));
    assert.deepEqual(Object.keys(result.spend ?? {}), [inputMint === WRAPPED_SOL_MINT ? "native" : inputMint]);
  });

  test(`mainnet ${fixture.kind} ${fixture.signature.slice(0, 10)} with its output redirected goes to review`, async () => {
    const original = await decodeFixture(fixture);
    const policy = fittedPolicy(original, inputMint);
    const destination = original.instructions.find((instruction) => instruction.swap)!.swap!.destinationTokenAccount;
    const redirected = await decodeFixture(fixture, [destination, Keypair.generate().publicKey.toBase58()]);
    const result = evaluatePolicy(redirected, policy);
    assert.equal(result.decision, "NEEDS_REVIEW");
    assert.ok(result.reasons.some((reason) => /neither the signer's own token account/.test(reason)), result.reasons.join("\n"));
  });
}
