import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, type AccountInfo, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";
import { accounts, getProposalPda, getTransactionPda, PROGRAM_ID as SQUADS_PROGRAM_ID } from "@sqds/multisig";
import { createServer } from "../src/api/server.js";
import { BPF_UPGRADEABLE_LOADER_PROGRAM_ID, type FetchLike } from "../src/gateway/squads-upgrade-gate.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";

function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

interface UpgradeMessageOptions {
  /** When set, routes the target program + buffer through an Address Lookup Table instead of static keys. */
  viaAlt?: { lookupTableKey: PublicKey };
}

function buildUpgradeMessage(targetProgramId: PublicKey, buffer: PublicKey, options: UpgradeMessageOptions = {}) {
  const spill = Keypair.generate().publicKey;
  const rentSysvar = Keypair.generate().publicKey;
  const clockSysvar = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const programData = Keypair.generate().publicKey;

  if (options.viaAlt) {
    // Static keys hold everything except the target program + buffer,
    // which resolve only through the lookup table -- the exact shape
    // that produced false NOT_AN_UPGRADE results before ALT resolution.
    return {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 4,
      accountKeys: [BPF_UPGRADEABLE_LOADER_PROGRAM_ID, programData, spill, rentSysvar, clockSysvar, authority],
      instructions: [
        {
          programIdIndex: 0,
          // Static indices 1..5 for ProgramData/spill/Rent/Clock/authority,
          // then ALT-resolved indices 6 (Program) and 7 (Buffer) appended
          // after the static keys by resolveFullAccountKeys.
          accountIndexes: new Uint8Array([1, 6, 7, 2, 3, 4, 5]),
          data: new Uint8Array([3, 0, 0, 0])
        }
      ],
      addressTableLookups: [{ accountKey: options.viaAlt.lookupTableKey, writableIndexes: new Uint8Array([0, 1]), readonlyIndexes: new Uint8Array([]) }]
    };
  }

  return {
    numSigners: 1,
    numWritableSigners: 1,
    numWritableNonSigners: 2,
    accountKeys: [BPF_UPGRADEABLE_LOADER_PROGRAM_ID, programData, targetProgramId, buffer, spill, rentSysvar, clockSysvar, authority],
    instructions: [
      {
        programIdIndex: 0,
        accountIndexes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
        data: new Uint8Array([3, 0, 0, 0])
      }
    ],
    addressTableLookups: []
  };
}

/**
 * Builds a real, SDK-serialized VaultTransaction account -- round tripped
 * through @sqds/multisig's own beet serializer, not a hand-typed byte
 * buffer standing in for one.
 */
function serializeVaultTransaction(
  multisigPda: PublicKey,
  index: number,
  message: ReturnType<typeof buildUpgradeMessage>
): Buffer {
  const vaultTransaction = accounts.VaultTransaction.fromArgs({
    multisig: multisigPda,
    creator: Keypair.generate().publicKey,
    index,
    bump: 255,
    vaultIndex: 0,
    vaultBump: 255,
    ephemeralSignerBumps: new Uint8Array(0),
    message
  });
  const [serialized] = vaultTransaction.serialize();
  return serialized;
}

type ProposalStatusKind = "Draft" | "Active" | "Rejected" | "Approved" | "Executing" | "Executed" | "Cancelled";

function serializeProposal(multisigPda: PublicKey, transactionIndex: number, statusKind: ProposalStatusKind): Buffer {
  const status = statusKind === "Executing" ? ({ __kind: "Executing" } as const) : ({ __kind: statusKind, timestamp: 0 } as const);
  const proposal = accounts.Proposal.fromArgs({
    multisig: multisigPda,
    transactionIndex,
    status: status as never,
    bump: 255,
    approved: [],
    rejected: [],
    cancelled: []
  });
  const [serialized] = proposal.serialize();
  return serialized;
}

function accountInfo(data: Buffer, owner: PublicKey = SQUADS_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

interface FakeConnectionOptions {
  lookupTables?: Map<string, PublicKey[]>;
}

/** Dispatches getAccountInfo by address so the transaction PDA and proposal PDA can return independent data, matching how evaluateSquadsUpgradeProposal actually reads both accounts. */
function fakeConnection(accountsByAddress: Map<string, AccountInfo<Buffer> | null>, options: FakeConnectionOptions = {}): Connection {
  return {
    getAccountInfo: async (address: PublicKey) => accountsByAddress.get(address.toBase58()) ?? null,
    getAddressLookupTable: async (address: PublicKey) => {
      const addresses = options.lookupTables?.get(address.toBase58());
      if (!addresses) return { value: null };
      return { value: { key: address, state: { addresses } } as unknown as AddressLookupTableAccount };
    }
  } as unknown as Connection;
}

function unknownVerificationFetch(): FetchLike {
  // No test here relies on a live network call -- verify.osec.io's tri-state
  // behavior itself is covered deterministically in squads-upgrade-gate.test.ts.
  // Here, no cluster is configured, so this must never even be called.
  return async () => {
    throw new Error("verification fetch should not be called when no cluster is configured");
  };
}

async function startServer(connection: Connection, extraConfig: Record<string, unknown> = {}) {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    connection,
    verificationFetch: unknownVerificationFetch(),
    ...extraConfig
  });
  const appServer = http.createServer(app);
  const handle = await listen(appServer);
  return { baseUrl: `http://localhost:${handle.port}`, close: handle.close };
}

test("POST /squads/upgrade-check evaluates an active legitimate upgrade proposal as NEEDS_REVIEW", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const targetProgramId = Keypair.generate().publicKey;
  const buffer = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [transactionPda.toBase58(), accountInfo(serializeVaultTransaction(multisigPda, 1, buildUpgradeMessage(targetProgramId, buffer)))],
    [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, "Active"))]
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.decision, "NEEDS_REVIEW");
    assert.equal(result.body.targetProgramId, targetProgramId.toBase58());
    assert.equal(result.body.bufferAddress, buffer.toBase58());
    assert.equal(result.body.proposalStatus, "Active");
    assert.equal(result.body.verificationHistory.outcome, "UNKNOWN");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check detects an Upgrade instruction routed entirely through an Address Lookup Table", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const targetProgramId = Keypair.generate().publicKey;
  const buffer = Keypair.generate().publicKey;
  const lookupTableKey = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [
      transactionPda.toBase58(),
      accountInfo(serializeVaultTransaction(multisigPda, 1, buildUpgradeMessage(targetProgramId, buffer, { viaAlt: { lookupTableKey } })))
    ],
    [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, "Active"))]
  ]);
  const lookupTables = new Map([[lookupTableKey.toBase58(), [targetProgramId, buffer]]]);

  const server = await startServer(fakeConnection(data, { lookupTables }));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.decision, "NEEDS_REVIEW", "an ALT-routed upgrade must still be detected, not missed as NOT_AN_UPGRADE");
    assert.equal(result.body.targetProgramId, targetProgramId.toBase58());
    assert.equal(result.body.bufferAddress, buffer.toBase58());
  } finally {
    await server.close();
  }
});

for (const statusKind of ["Rejected", "Cancelled", "Executed", "Draft", "Executing"] as const) {
  test(`POST /squads/upgrade-check reports a ${statusKind} proposal as NOT_PENDING, never as pending`, async () => {
    const multisigPda = Keypair.generate().publicKey;
    const targetProgramId = Keypair.generate().publicKey;
    const buffer = Keypair.generate().publicKey;
    const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
    const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });

    const data = new Map<string, AccountInfo<Buffer> | null>([
      [transactionPda.toBase58(), accountInfo(serializeVaultTransaction(multisigPda, 1, buildUpgradeMessage(targetProgramId, buffer)))],
      [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, statusKind))]
    ]);

    const server = await startServer(fakeConnection(data));
    try {
      const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.decision, "NOT_PENDING");
      assert.equal(result.body.proposalStatus, statusKind);
    } finally {
      await server.close();
    }
  });
}

test("POST /squads/upgrade-check fails closed when the Proposal account is missing", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [transactionPda.toBase58(), accountInfo(serializeVaultTransaction(multisigPda, 1, buildUpgradeMessage(Keypair.generate().publicKey, Keypair.generate().publicKey)))]
    // No proposal PDA entry -- getAccountInfo returns null for it.
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "ANALYSIS_INCOMPLETE");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check fails closed when the VaultTransaction account is owned by an untrusted program", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });
  const attackerProgram = Keypair.generate().publicKey;

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [
      transactionPda.toBase58(),
      accountInfo(serializeVaultTransaction(multisigPda, 1, buildUpgradeMessage(Keypair.generate().publicKey, Keypair.generate().publicKey)), attackerProgram)
    ],
    [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, "Active"))]
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "ANALYSIS_INCOMPLETE");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check fails closed when the Proposal account is owned by an untrusted program", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });
  const attackerProgram = Keypair.generate().publicKey;

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [transactionPda.toBase58(), accountInfo(serializeVaultTransaction(multisigPda, 1, buildUpgradeMessage(Keypair.generate().publicKey, Keypair.generate().publicKey)))],
    [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, "Active"), attackerProgram)]
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "ANALYSIS_INCOMPLETE");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check fails closed when the VaultTransaction's embedded multisig does not match the requested multisig", async () => {
  const requestedMultisig = Keypair.generate().publicKey;
  const embeddedMultisig = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda: requestedMultisig, index: 1n });
  const [proposalPda] = getProposalPda({ multisigPda: requestedMultisig, transactionIndex: 1n });

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [
      transactionPda.toBase58(),
      accountInfo(serializeVaultTransaction(embeddedMultisig, 1, buildUpgradeMessage(Keypair.generate().publicKey, Keypair.generate().publicKey)))
    ],
    [proposalPda.toBase58(), accountInfo(serializeProposal(requestedMultisig, 1, "Active"))]
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: requestedMultisig.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "ANALYSIS_INCOMPLETE");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check fails closed when the embedded transaction index does not match the requested index", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });

  const data = new Map<string, AccountInfo<Buffer> | null>([
    // PDA is derived for index 1, but the account itself claims index 7.
    [
      transactionPda.toBase58(),
      accountInfo(serializeVaultTransaction(multisigPda, 7, buildUpgradeMessage(Keypair.generate().publicKey, Keypair.generate().publicKey)))
    ],
    [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, "Active"))]
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "ANALYSIS_INCOMPLETE");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check returns NOT_AN_UPGRADE only for a genuine non-upgrade, after full resolution", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });

  const nonUpgradeMessage = {
    numSigners: 1,
    numWritableSigners: 1,
    numWritableNonSigners: 1,
    accountKeys: [Keypair.generate().publicKey, Keypair.generate().publicKey],
    instructions: [{ programIdIndex: 0, accountIndexes: new Uint8Array([1]), data: new Uint8Array([9, 9, 9, 9]) }],
    addressTableLookups: []
  };

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [transactionPda.toBase58(), accountInfo(serializeVaultTransaction(multisigPda, 1, nonUpgradeMessage))],
    [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, "Active"))]
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "NOT_AN_UPGRADE");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check cannot be redirected to an untrusted Squads program by a requester-supplied program ID", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const targetProgramId = Keypair.generate().publicKey;
  const buffer = Keypair.generate().publicKey;
  const [transactionPda] = getTransactionPda({ multisigPda, index: 1n }); // derived against the real, trusted Squads program
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: 1n });

  const data = new Map<string, AccountInfo<Buffer> | null>([
    [transactionPda.toBase58(), accountInfo(serializeVaultTransaction(multisigPda, 1, buildUpgradeMessage(targetProgramId, buffer)))],
    [proposalPda.toBase58(), accountInfo(serializeProposal(multisigPda, 1, "Active"))]
  ]);

  const server = await startServer(fakeConnection(data));
  try {
    // squadsProgramId is not part of the request schema -- zod strips it, so this
    // can't redirect which program's accounts are trusted. The server-side
    // config.squadsProgramId (unset here) is the only lever, and it's not
    // requester-controlled.
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, {
      multisigPda: multisigPda.toBase58(),
      transactionIndex: 1,
      squadsProgramId: Keypair.generate().publicKey.toBase58()
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.decision, "NEEDS_REVIEW");
    assert.equal(result.body.targetProgramId, targetProgramId.toBase58(), "evaluation still ran against the real trusted Squads program, unaffected by the extra field");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check rejects a malformed transactionIndex with 400, not 502", async () => {
  const server = await startServer(fakeConnection(new Map()));
  try {
    const result = await postJson(`${server.baseUrl}/squads/upgrade-check`, {
      multisigPda: Keypair.generate().publicKey.toBase58(),
      transactionIndex: "not-a-number"
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "INVALID_TRANSACTION_INDEX");
  } finally {
    await server.close();
  }
});

test("POST /squads/upgrade-check fails closed with CONNECTION_NOT_CONFIGURED when no connection is wired in", async () => {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const result = await postJson(`${baseUrl}/squads/upgrade-check`, { multisigPda: Keypair.generate().publicKey.toBase58(), transactionIndex: 1 });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "CONNECTION_NOT_CONFIGURED");
  } finally {
    await appHandle.close();
  }
});
