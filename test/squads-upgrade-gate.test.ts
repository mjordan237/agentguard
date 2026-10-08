import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type AccountInfo, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";
import {
  BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
  detectUpgradeInstruction,
  getBufferBytecodeEvidence,
  resolveFullAccountKeys,
  checkProgramVerificationHistory,
  parseTransactionIndex,
  parseKnownCluster,
  SUPPORTED_VERIFICATION_CLUSTER,
  type FetchLike
} from "../src/gateway/squads-upgrade-gate.js";

/**
 * Builds a compiled-message-shaped object carrying a real BPF Upgradeable
 * Loader Upgrade instruction, with the exact account order the loader's
 * own instruction processor expects: [0] ProgramData, [1] Program,
 * [2] Buffer, [3] spill, [4] Rent sysvar, [5] Clock sysvar, [6] authority.
 */
function buildUpgradeMessage(programId: PublicKey, buffer: PublicKey) {
  const programData = Keypair.generate().publicKey;
  const spill = Keypair.generate().publicKey;
  // Placeholder accounts -- their real sysvar identities don't matter for
  // this test, only that detectUpgradeInstruction reads the right indices.
  const rentSysvar = Keypair.generate().publicKey;
  const clockSysvar = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  const accountKeys = [
    BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
    programData,
    programId,
    buffer,
    spill,
    rentSysvar,
    clockSysvar,
    authority
  ];

  return {
    accountKeys,
    instructions: [
      {
        programIdIndex: 0,
        accountIndexes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
        data: new Uint8Array([3, 0, 0, 0]) // Upgrade discriminator
      }
    ]
  };
}

test("detectUpgradeInstruction finds a real Upgrade instruction and extracts program + buffer", () => {
  const programId = Keypair.generate().publicKey;
  const buffer = Keypair.generate().publicKey;
  const message = buildUpgradeMessage(programId, buffer);

  const detected = detectUpgradeInstruction(message);

  assert.ok(detected, "expected an upgrade to be detected");
  assert.equal(detected!.targetProgramId, programId.toBase58());
  assert.equal(detected!.bufferAddress, buffer.toBase58());
});

test("detectUpgradeInstruction ignores instructions on unrelated programs", () => {
  const unrelatedProgram = Keypair.generate().publicKey;
  const message = {
    accountKeys: [unrelatedProgram, Keypair.generate().publicKey],
    instructions: [{ programIdIndex: 0, accountIndexes: new Uint8Array([1]), data: new Uint8Array([3, 0, 0, 0]) }]
  };

  assert.equal(detectUpgradeInstruction(message), undefined);
});

test("detectUpgradeInstruction ignores other BPF loader instructions (e.g. Write, discriminator 1)", () => {
  const message = buildUpgradeMessage(Keypair.generate().publicKey, Keypair.generate().publicKey);
  message.instructions[0]!.data = new Uint8Array([1, 0, 0, 0]); // Write, not Upgrade

  assert.equal(detectUpgradeInstruction(message), undefined);
});

function upgradeableBufferAccount(programBytes: number[], owner: PublicKey = BPF_UPGRADEABLE_LOADER_PROGRAM_ID): AccountInfo<Buffer> {
  // UpgradeableLoaderState::Buffer serializes to 37 bytes: a four-byte
  // enum discriminator, an Option<Pubkey> tag, then the authority pubkey.
  const data = Buffer.alloc(37 + programBytes.length + 3);
  data.writeUInt32LE(1, 0);
  data[4] = 1;
  Buffer.from(programBytes).copy(data, 37);
  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

test("getBufferBytecodeEvidence hashes only executable bytes after the Buffer header and trailing allocation zeros", async () => {
  const buffer = Keypair.generate().publicKey;
  const account = upgradeableBufferAccount([1, 2, 3]);
  const connection = { getAccountInfo: async (address: PublicKey) => (address.equals(buffer) ? account : null) } as unknown as Connection;

  const evidence = await getBufferBytecodeEvidence(connection, buffer);

  assert.deepEqual(evidence, {
    outcome: "HASHED",
    sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    bytesHashed: 3
  });
});

test("getBufferBytecodeEvidence does not hash an account that is not a BPF Upgradeable Loader Buffer", async () => {
  const buffer = Keypair.generate().publicKey;
  const connection = {
    getAccountInfo: async () => upgradeableBufferAccount([1, 2, 3], Keypair.generate().publicKey)
  } as unknown as Connection;

  const evidence = await getBufferBytecodeEvidence(connection, buffer);

  assert.equal(evidence.outcome, "UNAVAILABLE");
  assert.match(evidence.reason, /not the BPF Upgradeable Loader/);
});

// --- resolveFullAccountKeys: ALT resolution ---

function fakeLookupTableConnection(tables: Map<string, PublicKey[]>, options: { throwOn?: string } = {}): Connection {
  return {
    getAddressLookupTable: async (address: PublicKey) => {
      const key = address.toBase58();
      if (options.throwOn === key) throw new Error("simulated RPC failure");
      const addresses = tables.get(key);
      if (!addresses) return { value: null };
      return { value: { key: address, state: { addresses } } as unknown as AddressLookupTableAccount };
    }
  } as unknown as Connection;
}

test("resolveFullAccountKeys passes through static keys unchanged when there are no lookup tables", async () => {
  const staticKeys = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const result = await resolveFullAccountKeys(fakeLookupTableConnection(new Map()), staticKeys, []);

  assert.ok(result.resolved);
  assert.deepEqual(
    result.resolved ? result.accountKeys.map((k) => k.toBase58()) : [],
    staticKeys.map((k) => k.toBase58())
  );
});

test("resolveFullAccountKeys resolves writable and readonly ALT entries in the correct order", async () => {
  const staticKeys = [Keypair.generate().publicKey];
  const tableKey = Keypair.generate().publicKey;
  const tableAddresses = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const tables = new Map([[tableKey.toBase58(), tableAddresses]]);

  const result = await resolveFullAccountKeys(fakeLookupTableConnection(tables), staticKeys, [
    { accountKey: tableKey, writableIndexes: new Uint8Array([0, 1]), readonlyIndexes: new Uint8Array([2, 3]) }
  ]);

  assert.ok(result.resolved);
  const expected = [staticKeys[0]!, tableAddresses[0]!, tableAddresses[1]!, tableAddresses[2]!, tableAddresses[3]!];
  assert.deepEqual(
    result.resolved ? result.accountKeys.map((k) => k.toBase58()) : [],
    expected.map((k) => k.toBase58())
  );
});

test("resolveFullAccountKeys preserves table order and index order across multiple lookup tables", async () => {
  const tableA = Keypair.generate().publicKey;
  const tableB = Keypair.generate().publicKey;
  const addressesA = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const addressesB = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const tables = new Map([
    [tableA.toBase58(), addressesA],
    [tableB.toBase58(), addressesB]
  ]);

  const result = await resolveFullAccountKeys(fakeLookupTableConnection(tables), [], [
    { accountKey: tableA, writableIndexes: new Uint8Array([1]), readonlyIndexes: new Uint8Array([]) },
    { accountKey: tableB, writableIndexes: new Uint8Array([0]), readonlyIndexes: new Uint8Array([]) }
  ]);

  assert.ok(result.resolved);
  // Writable section must preserve table order (A before B), then index order within each table.
  const expected = [addressesA[1]!, addressesB[0]!];
  assert.deepEqual(
    result.resolved ? result.accountKeys.map((k) => k.toBase58()) : [],
    expected.map((k) => k.toBase58())
  );
});

test("resolveFullAccountKeys fails closed when a lookup table is missing", async () => {
  const missingTable = Keypair.generate().publicKey;
  const result = await resolveFullAccountKeys(fakeLookupTableConnection(new Map()), [], [
    { accountKey: missingTable, writableIndexes: new Uint8Array([0]), readonlyIndexes: new Uint8Array([]) }
  ]);

  assert.equal(result.resolved, false);
});

test("resolveFullAccountKeys fails closed on an out-of-range writable index", async () => {
  const tableKey = Keypair.generate().publicKey;
  const tables = new Map([[tableKey.toBase58(), [Keypair.generate().publicKey]]]); // only index 0 exists

  const result = await resolveFullAccountKeys(fakeLookupTableConnection(tables), [], [
    { accountKey: tableKey, writableIndexes: new Uint8Array([5]), readonlyIndexes: new Uint8Array([]) }
  ]);

  assert.equal(result.resolved, false);
});

test("resolveFullAccountKeys fails closed on an out-of-range readonly index", async () => {
  const tableKey = Keypair.generate().publicKey;
  const tables = new Map([[tableKey.toBase58(), [Keypair.generate().publicKey]]]);

  const result = await resolveFullAccountKeys(fakeLookupTableConnection(tables), [], [
    { accountKey: tableKey, writableIndexes: new Uint8Array([]), readonlyIndexes: new Uint8Array([9]) }
  ]);

  assert.equal(result.resolved, false);
});

test("resolveFullAccountKeys fails closed when the RPC call itself throws", async () => {
  const tableKey = Keypair.generate().publicKey;
  const result = await resolveFullAccountKeys(fakeLookupTableConnection(new Map(), { throwOn: tableKey.toBase58() }), [], [
    { accountKey: tableKey, writableIndexes: new Uint8Array([0]), readonlyIndexes: new Uint8Array([]) }
  ]);

  assert.equal(result.resolved, false);
});

// --- checkProgramVerificationHistory: tri-state outcome ---

function fakeFetch(response: { ok: boolean; status: number; body: unknown } | { throws: Error }): FetchLike {
  return async () => {
    if ("throws" in response) throw response.throws;
    return { ok: response.ok, status: response.status, json: async () => response.body };
  };
}

test("checkProgramVerificationHistory returns VERIFIED for a documented verified response on the supported cluster", async () => {
  const fetchImpl = fakeFetch({
    ok: true,
    status: 200,
    body: { is_verified: true, repo_url: "https://github.com/example/program", last_verified_at: "2026-01-01T00:00:00Z", on_chain_hash: "abc" }
  });

  const status = await checkProgramVerificationHistory("SomeProgram111111111111111111111111111111", SUPPORTED_VERIFICATION_CLUSTER, fetchImpl);

  assert.equal(status.outcome, "VERIFIED");
  assert.equal(status.repoUrl, "https://github.com/example/program");
});

test("checkProgramVerificationHistory returns UNVERIFIED for the documented valid no-record response shape", async () => {
  // Real shape confirmed live against verify.osec.io for the actual
  // System Program address (never verified, never will be):
  // {"is_verified":false,"message":"On chain program not verified",
  //  "on_chain_hash":"","executable_hash":"","repo_url":"","commit":"",
  //  "last_verified_at":null,"is_frozen":false,"is_closed":true}
  const fetchImpl = fakeFetch({
    ok: true,
    status: 200,
    body: {
      is_verified: false,
      message: "On chain program not verified",
      on_chain_hash: "",
      executable_hash: "",
      repo_url: "",
      commit: "",
      last_verified_at: null,
      is_frozen: false,
      is_closed: true
    }
  });

  const status = await checkProgramVerificationHistory("11111111111111111111111111111111", SUPPORTED_VERIFICATION_CLUSTER, fetchImpl);

  assert.equal(status.outcome, "UNVERIFIED");
});

test("checkProgramVerificationHistory returns UNKNOWN, not UNVERIFIED, on HTTP 429", async () => {
  const status = await checkProgramVerificationHistory("x", SUPPORTED_VERIFICATION_CLUSTER, fakeFetch({ ok: false, status: 429, body: {} }));
  assert.equal(status.outcome, "UNKNOWN");
  assert.ok(status.reason);
});

test("checkProgramVerificationHistory returns UNKNOWN on HTTP 500/503", async () => {
  const status500 = await checkProgramVerificationHistory("x", SUPPORTED_VERIFICATION_CLUSTER, fakeFetch({ ok: false, status: 500, body: {} }));
  assert.equal(status500.outcome, "UNKNOWN");
  const status503 = await checkProgramVerificationHistory("x", SUPPORTED_VERIFICATION_CLUSTER, fakeFetch({ ok: false, status: 503, body: {} }));
  assert.equal(status503.outcome, "UNKNOWN");
});

test("checkProgramVerificationHistory returns UNKNOWN on a network rejection", async () => {
  const status = await checkProgramVerificationHistory("x", SUPPORTED_VERIFICATION_CLUSTER, fakeFetch({ throws: new Error("ECONNREFUSED") }));
  assert.equal(status.outcome, "UNKNOWN");
});

test("checkProgramVerificationHistory returns UNKNOWN on a timeout (AbortError)", async () => {
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  const status = await checkProgramVerificationHistory("x", SUPPORTED_VERIFICATION_CLUSTER, fakeFetch({ throws: abortError }));
  assert.equal(status.outcome, "UNKNOWN");
  assert.ok(status.reason?.includes("did not respond"));
});

test("checkProgramVerificationHistory returns UNKNOWN on invalid JSON", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    }
  });
  const status = await checkProgramVerificationHistory("x", SUPPORTED_VERIFICATION_CLUSTER, fetchImpl);
  assert.equal(status.outcome, "UNKNOWN");
});

test("checkProgramVerificationHistory returns UNKNOWN when the response is missing required fields", async () => {
  const status = await checkProgramVerificationHistory("x", SUPPORTED_VERIFICATION_CLUSTER, fakeFetch({ ok: true, status: 200, body: { message: "no is_verified field" } }));
  assert.equal(status.outcome, "UNKNOWN");
  assert.ok(status.reason?.includes("schema"));
});

test("checkProgramVerificationHistory never calls the provider for an unsupported cluster, and returns UNKNOWN", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ is_verified: true }) };
  };

  const devnetResult = await checkProgramVerificationHistory("x", "devnet", fetchImpl);
  assert.equal(devnetResult.outcome, "UNKNOWN");
  assert.equal(devnetResult.cluster, null);
  assert.equal(called, false, "verify.osec.io must not be called for a cluster it doesn't cover");

  const unsetResult = await checkProgramVerificationHistory("x", undefined, fetchImpl);
  assert.equal(unsetResult.outcome, "UNKNOWN");
  assert.equal(called, false);
});

// --- parseTransactionIndex / parseKnownCluster: input validation ---

test("parseTransactionIndex accepts non-negative integers as numbers and digit strings", () => {
  assert.equal(parseTransactionIndex(0), 0n);
  assert.equal(parseTransactionIndex(42), 42n);
  assert.equal(parseTransactionIndex("0"), 0n);
  assert.equal(parseTransactionIndex("18446744073709551615"), 2n ** 64n - 1n); // u64 max
});

test("parseTransactionIndex rejects fractional numbers", () => {
  assert.equal(parseTransactionIndex(1.5), undefined);
});

test("parseTransactionIndex rejects negative values", () => {
  assert.equal(parseTransactionIndex(-1), undefined);
  assert.equal(parseTransactionIndex("-1"), undefined);
});

test("parseTransactionIndex rejects unsafe JS numbers", () => {
  assert.equal(parseTransactionIndex(Number.MAX_SAFE_INTEGER + 1), undefined);
});

test("parseTransactionIndex rejects malformed strings and values outside u64 range", () => {
  assert.equal(parseTransactionIndex("not-a-number"), undefined);
  assert.equal(parseTransactionIndex("1.5"), undefined);
  assert.equal(parseTransactionIndex("18446744073709551616"), undefined); // u64 max + 1
});

test("parseKnownCluster accepts only the three known values", () => {
  assert.equal(parseKnownCluster("mainnet-beta"), "mainnet-beta");
  assert.equal(parseKnownCluster("devnet"), "devnet");
  assert.equal(parseKnownCluster("testnet"), "testnet");
  assert.equal(parseKnownCluster("Mainnet-Beta"), undefined);
  assert.equal(parseKnownCluster(undefined), undefined);
  assert.equal(parseKnownCluster(""), undefined);
});
