import { Connection, PublicKey } from "@solana/web3.js";
import { accounts, getTransactionPda } from "@sqds/multisig";

/**
 * Solana's native BPF Upgradeable Loader -- a fixed runtime address, the
 * same on every cluster, not something that varies per-deployment.
 */
export const BPF_UPGRADEABLE_LOADER_PROGRAM_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Borsh enum discriminator for UpgradeableLoaderInstruction::Upgrade
 * (variant index 3 of 8: InitializeBuffer, Write, DeployWithMaxDataLen,
 * Upgrade, SetAuthority, Close, ExtendProgram, SetAuthorityChecked),
 * encoded as a 4-byte little-endian u32 -- verified against the real
 * solana-loader-v3-interface enum, not guessed.
 */
const UPGRADE_DISCRIMINATOR = [3, 0, 0, 0];

/**
 * Account order for the Upgrade instruction, per the loader's own
 * instruction processor: [0] ProgramData, [1] Program, [2] Buffer,
 * [3] spill, [4] Rent sysvar, [5] Clock sysvar, [6] authority (signer).
 */
const PROGRAM_ACCOUNT_INDEX = 1;
const BUFFER_ACCOUNT_INDEX = 2;

export interface DetectedUpgrade {
  targetProgramId: string;
  bufferAddress: string;
}

interface CompiledMessageLike {
  accountKeys: PublicKey[];
  instructions: { programIdIndex: number; accountIndexes: Uint8Array; data: Uint8Array }[];
}

/** Scans a Squads vault transaction message for a BPF Upgradeable Loader Upgrade instruction. */
export function detectUpgradeInstruction(message: CompiledMessageLike): DetectedUpgrade | undefined {
  for (const instruction of message.instructions) {
    const programId = message.accountKeys[instruction.programIdIndex];
    if (!programId || !programId.equals(BPF_UPGRADEABLE_LOADER_PROGRAM_ID)) continue;
    if (instruction.data.length < 4) continue;
    const isUpgrade = UPGRADE_DISCRIMINATOR.every((byte, index) => instruction.data[index] === byte);
    if (!isUpgrade) continue;

    const targetProgram = message.accountKeys[instruction.accountIndexes[PROGRAM_ACCOUNT_INDEX]!];
    const buffer = message.accountKeys[instruction.accountIndexes[BUFFER_ACCOUNT_INDEX]!];
    if (!targetProgram || !buffer) continue;

    return { targetProgramId: targetProgram.toBase58(), bufferAddress: buffer.toBase58() };
  }
  return undefined;
}

/** Fetches a Squads vault transaction by index and checks it for a pending program upgrade. */
export async function fetchSquadsUpgradeProposal(
  connection: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  squadsProgramId?: PublicKey
): Promise<DetectedUpgrade | undefined> {
  const [transactionPda] = getTransactionPda({ multisigPda, index: transactionIndex, programId: squadsProgramId });
  const vaultTransaction = await accounts.VaultTransaction.fromAccountAddress(connection, transactionPda);
  return detectUpgradeInstruction(vaultTransaction.message);
}

export interface VerifiedBuildStatus {
  isVerified: boolean;
  repoUrl?: string;
  lastVerifiedAt?: string;
  onChainHash?: string;
}

/**
 * Checks a program's verification history via OtterSec's real, hosted
 * verify.osec.io API. This reports whether the program's *currently
 * deployed* bytecode has a known verified-build record -- it does not
 * (yet) verify the *pending* buffer's content, since that requires
 * computing the buffer account's own executable hash, and the exact
 * on-chain byte layout for that isn't confirmed precisely enough here
 * to do safely. Surfacing honest history beats guessing at a hash.
 */
export async function checkProgramVerificationHistory(programId: string): Promise<VerifiedBuildStatus> {
  const response = await fetch(`https://verify.osec.io/status/${programId}`);
  if (!response.ok) return { isVerified: false };
  const body = (await response.json()) as {
    is_verified?: boolean;
    repo_url?: string;
    last_verified_at?: string;
    on_chain_hash?: string;
  };
  return {
    isVerified: Boolean(body.is_verified),
    repoUrl: body.repo_url,
    lastVerifiedAt: body.last_verified_at,
    onChainHash: body.on_chain_hash
  };
}

export interface SquadsUpgradeEvaluation {
  /** Always NEEDS_REVIEW when an upgrade is detected -- this surfaces context, it never autonomously clears an upgrade. */
  decision: "NOT_AN_UPGRADE" | "NEEDS_REVIEW";
  targetProgramId?: string;
  bufferAddress?: string;
  verificationHistory?: VerifiedBuildStatus;
  reasons: string[];
}

/**
 * The gap this fills: a Squads signer gets no automated context before
 * approving a program upgrade today -- verification is a manual,
 * external CLI step nothing in Squads' own UI surfaces. This doesn't
 * close that gap entirely (see checkProgramVerificationHistory's own
 * caveat), but it's a real improvement over the blank signing screen
 * that exists right now.
 */
export async function evaluateSquadsUpgradeProposal(
  connection: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  squadsProgramId?: PublicKey
): Promise<SquadsUpgradeEvaluation> {
  const detected = await fetchSquadsUpgradeProposal(connection, multisigPda, transactionIndex, squadsProgramId);
  if (!detected) {
    return { decision: "NOT_AN_UPGRADE", reasons: ["This proposal does not contain a BPF Upgradeable Loader Upgrade instruction."] };
  }

  const verificationHistory = await checkProgramVerificationHistory(detected.targetProgramId);
  const reasons: string[] = [];
  if (!verificationHistory.isVerified) {
    reasons.push(
      `Program ${detected.targetProgramId} has no verified-build record on file. Approving this upgrade means trusting bytecode with no independent source match on record.`
    );
  } else {
    reasons.push(
      `Program ${detected.targetProgramId} was last verified against ${verificationHistory.repoUrl ?? "an unrecorded repository"} on ${verificationHistory.lastVerifiedAt ?? "an unrecorded date"}. That reflects the program's history, not the pending buffer -- confirm buffer ${detected.bufferAddress} has itself been verified against an updated commit before approving.`
    );
  }

  return { decision: "NEEDS_REVIEW", targetProgramId: detected.targetProgramId, bufferAddress: detected.bufferAddress, verificationHistory, reasons };
}
