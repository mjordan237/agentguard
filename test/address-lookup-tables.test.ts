import test from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  PublicKey
} from "@solana/web3.js";
import { idlSha256 } from "solana-clear-sign";
import { IdlRegistry } from "../src/agent-integration/idl-registry.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();

const systemProgramIdl = {
  version: "0.1.0",
  name: "system_program",
  instructions: [
    {
      name: "transfer",
      discriminator: [2, 0, 0, 0],
      accounts: [{ name: "from" }, { name: "to" }],
      args: [{ name: "lamports", type: "u64", display: { label: "Amount", formatter: { kind: "amount", isNative: true } } }],
      display: { mode: "interpolated", template: "Transfer {lamports} to {to}" }
    }
  ]
};

function buildRegistry(): IdlRegistry {
  const registry = new IdlRegistry();
  registry.register(SYSTEM_PROGRAM_ID, {
    idl: systemProgramIdl,
    provenance: { source: "embedded", expectedSha256: idlSha256(systemProgramIdl), expectedProgramId: SYSTEM_PROGRAM_ID }
  });
  return registry;
}

/**
 * Builds a real v0 transaction whose destination account is only
 * reachable through an Address Lookup Table -- not present in static
 * account keys at all -- plus the AddressLookupTableAccount object a
 * resolver would hand back. No RPC round-trip: the ALT object is
 * constructed locally with a real address and a real address list,
 * which is exactly the shape `Connection.getAddressLookupTable` returns
 * in production, just without needing a live devnet table for this test.
 */
function buildAltTransaction(): { transactionBase64: string; lookupTableAccount: AddressLookupTableAccount; destination: PublicKey } {
  const feePayer = Keypair.generate();
  const destination = Keypair.generate();
  const lookupTableAddress = Keypair.generate().publicKey;

  const lookupTableAccount = new AddressLookupTableAccount({
    key: lookupTableAddress,
    state: {
      deactivationSlot: 0xffffffffffffffffn, // "active" sentinel per AddressLookupTableAccount.isActive()
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: feePayer.publicKey,
      addresses: [destination.publicKey]
    }
  });

  const instruction = SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: destination.publicKey, lamports: 42_000 });
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [instruction]
  }).compileToV0Message([lookupTableAccount]);

  assert.equal(message.addressTableLookups.length, 1, "test setup: destination must actually be resolved via the ALT, not static keys");

  const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  return { transactionBase64, lookupTableAccount, destination: destination.publicKey };
}

test("resolves a destination account that only exists in an Address Lookup Table", async () => {
  const { transactionBase64, lookupTableAccount, destination } = buildAltTransaction();
  const registry = buildRegistry();

  const decoded = await parseAndDecodeTransaction(transactionBase64, registry, async (address) =>
    address.equals(lookupTableAccount.key) ? lookupTableAccount : null
  );

  assert.equal(decoded.instructions.length, 1);
  assert.notEqual(decoded.instructions[0].mode, "raw_dump");
  assert.equal(decoded.instructions[0].fields.to, destination.toBase58());
});

test("fails closed to NEEDS_REVIEW-shaped raw_dump when no resolver is configured", async () => {
  const { transactionBase64 } = buildAltTransaction();
  const registry = buildRegistry();

  const decoded = await parseAndDecodeTransaction(transactionBase64, registry /* no resolver */);

  assert.equal(decoded.instructions.length, 1);
  assert.equal(decoded.instructions[0].mode, "raw_dump");
});

test("fails closed when the resolver can't find the lookup table", async () => {
  const { transactionBase64 } = buildAltTransaction();
  const registry = buildRegistry();

  const decoded = await parseAndDecodeTransaction(transactionBase64, registry, async () => null);

  assert.equal(decoded.instructions.length, 1);
  assert.equal(decoded.instructions[0].mode, "raw_dump");
  assert.match(String(decoded.instructions[0].fields.reason), /could not be resolved/);
});
