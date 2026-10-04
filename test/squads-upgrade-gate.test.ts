import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
  detectUpgradeInstruction,
  checkProgramVerificationHistory
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

test("checkProgramVerificationHistory reads real verification status from verify.osec.io", async () => {
  // A real, known-verified program (Ellipsis Labs' Phoenix v1) -- confirmed
  // live against the actual API before writing this test, not assumed.
  const status = await checkProgramVerificationHistory("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY");

  assert.equal(status.isVerified, true);
  assert.equal(status.repoUrl, "https://github.com/Ellipsis-Labs/phoenix-v1");
  assert.ok(status.onChainHash && status.onChainHash.length > 0);
});

test("checkProgramVerificationHistory reports unverified for a program with no record", async () => {
  // A syntactically valid but almost certainly never-deployed-or-verified
  // address -- the System Program itself has no verify.osec.io record.
  const status = await checkProgramVerificationHistory("11111111111111111111111111111111111111111");

  assert.equal(status.isVerified, false);
});
