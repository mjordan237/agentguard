import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { idlSha256 } from "solana-clear-sign";
import { IdlRegistry } from "../src/agent-integration/idl-registry.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();

// System Program's Transfer instruction: 4-byte little-endian u32
// discriminator (value 2), followed by an 8-byte u64 lamports amount.
const systemProgramIdl = {
  version: "0.1.0",
  name: "system_program",
  instructions: [
    {
      name: "transfer",
      discriminator: [2, 0, 0, 0],
      accounts: [{ name: "from" }, { name: "to" }],
      args: [
        {
          name: "lamports",
          type: "u64",
          display: { label: "Amount", formatter: { kind: "amount", isNative: true } }
        }
      ],
      display: { mode: "interpolated", template: "Transfer {lamports} to {to}" }
    }
  ]
};

function buildRegistry(): IdlRegistry {
  const registry = new IdlRegistry();
  registry.register(SYSTEM_PROGRAM_ID, {
    idl: systemProgramIdl,
    provenance: {
      source: "embedded",
      expectedSha256: idlSha256(systemProgramIdl),
      expectedProgramId: SYSTEM_PROGRAM_ID
    }
  });
  return registry;
}

function buildTransferTransactionBase64(lamports: number): string {
  const feePayer = Keypair.generate();
  const destination = Keypair.generate();
  const instruction = SystemProgram.transfer({
    fromPubkey: feePayer.publicKey,
    toPubkey: destination.publicKey,
    lamports
  });
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [instruction]
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  return Buffer.from(transaction.serialize()).toString("base64");
}

test("decodes a real System Program transfer instruction end to end", async () => {
  const registry = buildRegistry();
  const txBase64 = buildTransferTransactionBase64(1_000_000);
  const decoded = await parseAndDecodeTransaction(txBase64, registry);

  assert.equal(decoded.instructions.length, 1);
  assert.notEqual(decoded.instructions[0].mode, "raw_dump");
  assert.equal(decoded.instructions[0].programId, SYSTEM_PROGRAM_ID);
});

test("falls back to raw_dump for a program not in the registry", async () => {
  const emptyRegistry = new IdlRegistry();
  const txBase64 = buildTransferTransactionBase64(500);
  const decoded = await parseAndDecodeTransaction(txBase64, emptyRegistry);

  assert.equal(decoded.instructions.length, 1);
  assert.equal(decoded.instructions[0].mode, "raw_dump");
});
