import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { parseEvmTx, parseSpent, policyNotes } from "../src/cli/check.js";
import { parsePolicy } from "../src/policy/validate.js";

const SOL = 1_000_000_000;
const CLI = path.resolve(import.meta.dirname, "../src/cli/check.js");
const dir = mkdtempSync(path.join(tmpdir(), "agentguard-check-"));
const write = (name: string, content: string) => { const f = path.join(dir, name); writeFileSync(f, content); return f; };
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 120_000 });

const agent = Keypair.generate().publicKey;
const vendor = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const attackerProgram = Keypair.generate().publicKey;
const tx = (...instructions: ReturnType<typeof SystemProgram.transfer>[]) => Buffer.from(new VersionedTransaction(new TransactionMessage({
  payerKey: agent, recentBlockhash: PublicKey.default.toBase58(), instructions
}).compileToV0Message()).serialize()).toString("base64");
const pay = (to: PublicKey, sol: number) => SystemProgram.transfer({ fromPubkey: agent, toPubkey: to, lamports: Math.round(sol * SOL) });

const solPolicy = write("sol.json", JSON.stringify({
  policyId: "t", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [vendor.toBase58()],
  maxAmountPerTransaction: { native: String(SOL) }, maxAmountPerDay: { native: String(5 * SOL) }
}));

test("check: an allowed Solana payment exits 0, and the exit code differs for a held one", () => {
  const ok = run("--policy", solPolicy, "--tx", tx(pay(vendor, 0.25)));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Decision: ALLOW/);
  assert.match(ok.stdout, /transfer/);

  const hidden = run("--policy", solPolicy, "--tx", tx(pay(vendor, 0.25), SystemProgram.assign({ accountPubkey: agent, programId: attackerProgram })));
  assert.equal(hidden.status, 2);
  assert.match(hidden.stdout, /NEEDS_REVIEW/);
  assert.match(hidden.stdout, /could not be verified/);

  const stranger1 = run("--policy", solPolicy, "--tx", tx(pay(stranger, 0.25)));
  assert.equal(stranger1.status, 2);
  assert.match(stranger1.stdout, /not in the allowlist/);
});

test("check: --tx-file and --json give the same decision, and --spent counts against the daily limit", () => {
  const file = write("tx.b64", tx(pay(vendor, 0.25)) + "\n");
  const j = run("--policy", solPolicy, "--tx-file", file, "--json");
  assert.equal(j.status, 0);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.decision, "ALLOW");
  assert.equal(parsed.decoded.instructions[0].amount, "250000000");

  const over = run("--policy", solPolicy, "--tx-file", file, "--spent", `native=${5 * SOL}`);
  assert.equal(over.status, 2);
  assert.match(over.stdout, /daily limit/);
});

test("check: bad input exits 1 with a clear message and never prints a stack trace", () => {
  const badPolicy = write("bad.json", JSON.stringify({ policyId: "x", programAllowlist: "nope", maxAmountPerTransaction: { native: "-5" }, extra: 1 }));
  const r1 = run("--policy", badPolicy, "--tx", tx(pay(vendor, 1)));
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /Policy problem: Invalid policy/);
  assert.doesNotMatch(r1.stderr, /\n\s+at /);

  const r2 = run("--policy", solPolicy, "--tx", "not-base64!!");
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Could not read the transaction/);

  assert.equal(run("--policy", solPolicy).status, 1);
  assert.equal(run("--policy", solPolicy, "--tx", "a", "--tx-file", "b").status, 1);
  assert.equal(run("--policy", "/no/such/file.json", "--tx", "a").status, 1);
  assert.equal(run("--policy", solPolicy, "--tx", tx(pay(vendor, 1)), "--spent", "native=1.5").status, 1);
  assert.equal(run("--bogus").status, 1);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Exit code: 0 ALLOW, 2 NEEDS_REVIEW/);
});

test("check: EVM transactions use the EVM evaluator (unlimited approval held, bounded one allowed)", () => {
  const spender = "0x2222222222222222222222222222222222222222";
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const evmPolicy = write("evm.json", JSON.stringify({
    policyId: "e", programAllowlist: [usdc], destinationAllowlist: [spender],
    maxAmountPerTransaction: { [usdc]: "1000000000" }, maxAmountPerDay: { [usdc]: "3000000000" }, allowedChainIds: [1]
  }));
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  const approve = (amount: bigint) => write(`a${amount}.json`, JSON.stringify({ chainId: 1, from: "0x1111111111111111111111111111111111111111", to: usdc, data: `0x095ea7b3${spender.slice(2).padStart(64, "0")}${word(amount)}` }));
  assert.equal(run("--policy", evmPolicy, "--evm-tx", approve(100_000_000n)).status, 0);
  const max = run("--policy", evmPolicy, "--evm-tx", approve((1n << 256n) - 1n));
  assert.equal(max.status, 2);
  assert.match(max.stdout, /exceeds the per-transaction limit/);
});

test("check: helpers reject malformed amounts and EVM files, and policy notes flag settings that hold everything", () => {
  assert.deepEqual(parseSpent("native=5,Mint=7"), { native: 5n, Mint: 7n });
  assert.deepEqual(parseSpent(undefined), {});
  for (const bad of ["native", "native=", "native=-1", "native=1.5", "native=1=2", "=5", "native=٣"]) assert.throws(() => parseSpent(bad), /--spent/, bad);

  assert.throws(() => parseEvmTx("{"), /not valid JSON/);
  assert.throws(() => parseEvmTx('{"chainId":1.5,"from":"0x1"}'), /chainId/);
  assert.throws(() => parseEvmTx('{"chainId":1,"from":"0x1","value":5}'), /value/);
  assert.throws(() => parseEvmTx('{"chainId":1,"from":"0x1","value":"-1"}'), /value/);
  assert.equal(parseEvmTx('{"chainId":1,"from":"0x1","value":"12"}').value, 12n);

  const empty = parsePolicy({ policyId: "p", programAllowlist: [], destinationAllowlist: [], maxAmountPerTransaction: {}, maxAmountPerDay: {} });
  assert.equal(policyNotes(empty).length, 4);
  assert.equal(policyNotes({ ...empty, allowAnyDestination: true }).length, 3);
});
