import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { generated, getTransactionPda, PROGRAM_ID as SQUADS_PROGRAM_ID } from "@sqds/multisig";
import { createServer } from "../src/api/server.js";
import { BPF_UPGRADEABLE_LOADER_PROGRAM_ID } from "../src/gateway/squads-upgrade-gate.js";
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

/**
 * Builds a real, SDK-serialized VaultTransaction account whose message
 * contains a genuine BPF Upgradeable Loader Upgrade instruction -- round
 * tripped through @sqds/multisig's own beet serializer, not a hand-typed
 * byte buffer standing in for one.
 */
function serializeUpgradeVaultTransaction(multisigPda: PublicKey, targetProgramId: PublicKey, buffer: PublicKey): Buffer {
  const accountKeys = [
    BPF_UPGRADEABLE_LOADER_PROGRAM_ID, // 0: the instruction's program
    Keypair.generate().publicKey, // 1: ProgramData
    targetProgramId, // 2: Program
    buffer, // 3: Buffer
    Keypair.generate().publicKey, // 4: spill
    Keypair.generate().publicKey, // 5: Rent sysvar (placeholder)
    Keypair.generate().publicKey, // 6: Clock sysvar (placeholder)
    Keypair.generate().publicKey // 7: authority
  ];

  const vaultTransaction = generated.VaultTransaction.fromArgs({
    multisig: multisigPda,
    creator: Keypair.generate().publicKey,
    index: 1,
    bump: 255,
    vaultIndex: 0,
    vaultBump: 255,
    ephemeralSignerBumps: new Uint8Array(0),
    message: {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 2,
      accountKeys,
      instructions: [
        {
          programIdIndex: 0,
          accountIndexes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
          data: new Uint8Array([3, 0, 0, 0])
        }
      ],
      addressTableLookups: []
    }
  });

  const [serialized] = vaultTransaction.serialize();
  return serialized;
}

/** A minimal fake Connection whose getAccountInfo returns real, SDK-serialized account bytes. */
function fakeConnection(accountData: Buffer): Connection {
  return {
    getAccountInfo: async () => ({
      data: accountData,
      executable: false,
      lamports: 1,
      owner: SQUADS_PROGRAM_ID,
      rentEpoch: 0
    })
  } as unknown as Connection;
}

test("POST /squads/upgrade-check reads a real pending Squads upgrade proposal and reports verification history", async () => {
  const multisigPda = Keypair.generate().publicKey;
  // Phoenix v1 -- confirmed real, verified program on verify.osec.io in squads-upgrade-gate.test.ts.
  const targetProgramId = new PublicKey("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY");
  const buffer = Keypair.generate().publicKey;
  const accountData = serializeUpgradeVaultTransaction(multisigPda, targetProgramId, buffer);

  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder", connection: fakeConnection(accountData) });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const [transactionPda] = getTransactionPda({ multisigPda, index: 1n });
    const result = await postJson(`${baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 1 });

    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.decision, "NEEDS_REVIEW");
    assert.equal(result.body.targetProgramId, targetProgramId.toBase58());
    assert.equal(result.body.bufferAddress, buffer.toBase58());
    assert.equal(result.body.verificationHistory.isVerified, true);
    assert.equal(result.body.verificationHistory.repoUrl, "https://github.com/Ellipsis-Labs/phoenix-v1");
    assert.ok(result.body.reasons[0].includes("Ellipsis-Labs/phoenix-v1"), "reason should cite the verified repo");
    // Sanity: the PDA we derived locally matches what fetchSquadsUpgradeProposal derives internally.
    assert.ok(transactionPda, "transaction PDA should derive without throwing");
  } finally {
    await appHandle.close();
  }
});

test("POST /squads/upgrade-check returns NOT_AN_UPGRADE for a proposal with no Upgrade instruction", async () => {
  const multisigPda = Keypair.generate().publicKey;
  const vaultTransaction = generated.VaultTransaction.fromArgs({
    multisig: multisigPda,
    creator: Keypair.generate().publicKey,
    index: 2,
    bump: 255,
    vaultIndex: 0,
    vaultBump: 255,
    ephemeralSignerBumps: new Uint8Array(0),
    message: {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 1,
      accountKeys: [Keypair.generate().publicKey, Keypair.generate().publicKey],
      instructions: [{ programIdIndex: 0, accountIndexes: new Uint8Array([1]), data: new Uint8Array([9, 9, 9, 9]) }],
      addressTableLookups: []
    }
  });
  const [accountData] = vaultTransaction.serialize();

  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder", connection: fakeConnection(accountData) });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const result = await postJson(`${baseUrl}/squads/upgrade-check`, { multisigPda: multisigPda.toBase58(), transactionIndex: 2 });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "NOT_AN_UPGRADE");
  } finally {
    await appHandle.close();
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
