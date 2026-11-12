import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { decodeEvmTransaction, type EvmTransaction } from "../src/evm/decode.js";
import { decodeEvmTypedData, type TypedDataRequest, PERMIT2 } from "../src/evm/typed-data.js";
import { SWAP_ROUTERS } from "../src/evm/uniswap.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { registerStandardPrograms, TOKEN_PROGRAM } from "../src/agent-integration/standard-programs.js";
import { summarizeTransaction } from "../src/escalation/review-view.js";
import { classifyInstruction } from "../src/policy/operation.js";
import type { DecodedTransactionSummary } from "../src/policy/types.js";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { V } from "./evm-uniswap-vectors.js";
import { sellSol } from "./jupiter-builders.js";

// Real decoder output, not hand-written summaries: every case below runs the decoder a review would store.
const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const nft = "0x4444444444444444444444444444444444444444";
const MAX256 = (1n << 256n) - 1n;
const MAX160 = (1n << 160n) - 1n;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const call = (sel: string, ...args: string[]) => `0x${sel}${args.join("")}`;
const evm = (over: Partial<EvmTransaction>) => decodeEvmTransaction({ chainId: 1, from: agent, ...over });
const summary = (decoded: DecodedTransactionSummary) => summarizeTransaction({ decision: "NEEDS_REVIEW", reasons: [], decoded });
const kinds = (decoded: DecodedTransactionSummary) => decoded.instructions.map((i) => classifyInstruction(i).kind);

test("EVM approvals are approvals, not payments; an unlimited one says so", () => {
  const unlimited = summary(evm({ to: usdc, data: call("095ea7b3", addr(vendor), word(MAX256)) }));
  assert.equal(unlimited.text, `Unlimited approval: lets ${vendor} spend any amount of ${usdc}`);
  assert.equal(unlimited.unlimitedApproval, true);
  assert.equal(unlimited.transfers, 0, "an approval moves nothing");
  assert.equal(unlimited.single, undefined);

  const capped = summary(evm({ to: usdc, data: call("095ea7b3", addr(vendor), word(5_000_000n)) }));
  assert.equal(capped.text, `Approval: lets ${vendor} spend up to 5000000 ${usdc}`);
  assert.equal(capped.unlimitedApproval, false);

  assert.equal(summary(evm({ to: usdc, data: call("095ea7b3", addr(vendor), word(0n)) })).text, `Revokes the allowance of ${vendor} on ${usdc}`);
  assert.equal(summary(evm({ to: usdc, data: call("39509351", addr(vendor), word(MAX256)) })).text, `Unlimited approval: lets ${vendor} spend any amount of ${usdc}`, "increaseAllowance");
});

test("EVM NFT operator approvals, transfers, wrapping and unknown calls are each named for what they are", () => {
  assert.equal(summary(evm({ to: nft, data: call("a22cb465", addr(vendor), word(1n)) })).text, `Gives ${vendor} control of every NFT in ${nft}`);
  assert.deepEqual(kinds(evm({ to: nft, data: call("a22cb465", addr(vendor), word(1n)) })), ["nft_operator_approval"]);
  assert.equal(summary(evm({ to: nft, data: call("a22cb465", addr(vendor), word(0n)) })).text, `Removes ${vendor} as operator of ${nft}`);
  assert.equal(summary(evm({ to: vendor, value: 7n })).text, `Transfer of 7 native to ${vendor}`);
  assert.equal(summary(evm({ to: usdc, data: call("a9059cbb", addr(vendor), word(9n)) })).text, `Transfer of 9 ${usdc} to ${vendor}`);
  assert.equal(summary(evm({ to: usdc, data: call("23b872dd", addr(agent), addr(vendor), word(9n)) })).text, `Transfer of 9 ${usdc} to ${vendor}`, "transferFrom the sender");
  const weth = SWAP_ROUTERS[1].weth;
  assert.equal(summary(evm({ to: weth, value: 3n, data: "0xd0e30db0" })).text, "Wraps 3 native into its wrapped token", "WETH deposit is not a payment to WETH");
  assert.equal(summary(evm({ to: weth, data: call("2e1a7d4d", word(4n)) })).text, `Unwraps 4 ${weth}`);
  assert.equal(summary(evm({ to: vendor, data: "0xdeadbeef" })).text, "1 instruction could not be decoded");
  // A malformed blanket grant is not mistaken for a recognised one.
  assert.deepEqual(kinds(evm({ to: nft, data: call("a22cb465", addr(vendor), word(2n)) })), ["undecoded"]);
});

test("Uniswap swaps decoded from real calldata are swaps, not transfers to the recipient", () => {
  const router = SWAP_ROUTERS[1].router;
  const single = summary(evm({ to: router, data: V.eis_self }));
  assert.equal(single.swaps, 1);
  assert.equal(single.transfers, 0);
  assert.match(single.text, new RegExp(`^Swap of up to \\d+ ${usdc} for at least \\d+ ${SWAP_ROUTERS[1].weth}$`));
  // A swap-then-unwrap multicall: the decoder folds the unwrap into the swap's recipient.
  const withUnwrap = evm({ to: router, data: V.mc_swap_unwrap_self });
  assert.deepEqual(kinds(withUnwrap), ["swap"]);
  assert.doesNotMatch(summary(withUnwrap).text, /Transfer/);
});

test("signed permits are approvals by signature; Permit2 and DAI unlimited forms are flagged", () => {
  const FAR = "1800003600";
  const erc2612 = (value: string): TypedDataRequest => ({
    from: agent,
    typedData: { domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: usdc }, primaryType: "Permit",
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      message: { owner: agent, spender: vendor, value, nonce: "0", deadline: FAR } }
  });
  assert.equal(summary(decodeEvmTypedData(erc2612(MAX256.toString()))).text, `Unlimited approval by signature: lets ${vendor} spend any amount of ${usdc}`);
  assert.equal(summary(decodeEvmTypedData(erc2612("500"))).text, `Approval by signature: lets ${vendor} spend up to 500 ${usdc}`);

  const permit2 = (amount: string): TypedDataRequest => ({
    from: agent,
    typedData: { domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 }, primaryType: "PermitSingle",
      types: { PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
      message: { details: { token: usdc, amount, expiration: FAR, nonce: "0" }, spender: vendor, sigDeadline: FAR } }
  });
  const p2 = summary(decodeEvmTypedData(permit2(MAX160.toString())));
  assert.equal(p2.unlimitedApproval, true, "Permit2's uint160 maximum is unlimited");
  assert.equal(p2.transfers, 0);

  const dai = (allowed: boolean): TypedDataRequest => ({
    from: agent,
    typedData: { domain: { name: "Dai Stablecoin", version: "1", chainId: 1, verifyingContract: "0x6b175474e89094c44da98b954eedeac495271d0f" }, primaryType: "Permit",
      types: { Permit: [{ name: "holder", type: "address" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "allowed", type: "bool" }] },
      message: { holder: agent, spender: vendor, nonce: "0", expiry: FAR, allowed } }
  });
  assert.equal(summary(decodeEvmTypedData(dai(true))).unlimitedApproval, true);
  assert.match(summary(decodeEvmTypedData(dai(false))).text, /^Revokes the allowance of .* by signature$/);
});

test("Solana: SPL transfers and Jupiter swaps from real transactions keep transfer totals per asset", async () => {
  const registry = registerStandardPrograms(buildDemoRegistry());
  const payer = Keypair.generate().publicKey;
  const encode = (ixs: TransactionInstruction[]) => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message()).serialize()).toString("base64");
  const transferChecked = (mint: PublicKey, destination: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = 6;
    return new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data, keys: [Keypair.generate().publicKey, mint, destination, payer].map((pubkey, i) => ({ pubkey, isSigner: i === 3, isWritable: i !== 1 && i !== 3 })) });
  };
  const mintA = Keypair.generate().publicKey, mintB = Keypair.generate().publicKey;
  const d1 = Keypair.generate().publicKey, d2 = Keypair.generate().publicKey;
  const decoded = await parseAndDecodeTransaction(encode([transferChecked(mintA, d1, 5n), transferChecked(mintB, d2, 7n), transferChecked(mintA, d2, 2n)]), registry);
  const s = summary(decoded);
  assert.equal(s.text, "3 transfers across 2 assets to 2 destinations");
  assert.deepEqual(s.assets.map((a) => [a.asset, a.total]), [[mintA.toBase58(), 7n], [mintB.toBase58(), 7n]], "never added across mints");

  const swap = await parseAndDecodeTransaction(encode(sellSol().instructions), registry);
  const swapSummary = summary(swap);
  assert.equal(swapSummary.swaps, 1);
  assert.ok(kinds(swap).includes("swap"));
  assert.match(swapSummary.text, /Swap of up to 1000000000 /);
});

test("end to end: an unlimited approval escalated through the EVM API is shown in the queue as an approval", async () => {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, {
    policyId: "acme-evm", programAllowlist: ["evm:native", usdc], destinationAllowlist: [vendor],
    maxAmountPerTransaction: { native: "1000000000000000000", [usdc]: "1000000000" }, maxAmountPerDay: { native: "3000000000000000000", [usdc]: "3000000000" },
    allowedChainIds: [1]
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const reviewers = new ReviewerStore();
  const token = reviewers.create("Ops").token;
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://placeholder", customers, reviewers });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const evaluate = (data: string) => fetch(`${base}/evaluate-evm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ agentId: "a", policyId: "acme-evm", transaction: { chainId: 1, from: agent, to: usdc, data } }) }).then((r) => r.json() as Promise<{ decision: string; reviewId: string }>);
    const approval = await evaluate(call("095ea7b3", addr(vendor), word(MAX256)));
    assert.equal(approval.decision, "NEEDS_REVIEW");
    const queue = (await (await fetch(`${base}/operator/api/reviews`, { headers: { "x-reviewer-token": token } })).json()) as { items: Array<{ id: string; chain: string; summary: { text: string; unlimitedApproval: boolean; transfers: number } }> };
    const item = queue.items.find((i) => i.id === approval.reviewId)!;
    assert.equal(item.chain, "evm:1");
    assert.equal(item.summary.unlimitedApproval, true);
    assert.equal(item.summary.transfers, 0);
    assert.match(item.summary.text, /^Unlimited approval: /);
    const detail = (await (await fetch(`${base}/operator/api/reviews/${approval.reviewId}`, { headers: { "x-reviewer-token": token } })).json()) as { summary: { operations: Array<{ kind: string; unlimited: boolean }> } };
    assert.deepEqual(detail.summary.operations.map((o) => [o.kind, o.unlimited]), [["approval", true]]);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
