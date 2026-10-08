import type { AddressLookupTableAccount, Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { accounts, getProposalPda, getTransactionPda, PROGRAM_ID as SQUADS_PROGRAM_ID } from "@sqds/multisig";

/**
 * Solana's native BPF Upgradeable Loader -- a fixed runtime address, the
 * same on every cluster, not something that varies per-deployment.
 */
export const BPF_UPGRADEABLE_LOADER_PROGRAM_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Discriminator for UpgradeableLoaderInstruction::Upgrade (variant index
 * 3 of 8: InitializeBuffer, Write, DeployWithMaxDataLen, Upgrade,
 * SetAuthority, Close, ExtendProgram, SetAuthorityChecked), a 4-byte
 * little-endian u32. The native loader encodes this with bincode, not
 * Borsh -- Solana's native/built-in programs predate Borsh's adoption
 * and use bincode; Borsh is the Anchor-ecosystem convention for custom
 * programs (like Squads' own program). Both encode a bare enum
 * discriminant as a 4-byte LE u32 here, so the byte value is the same
 * either way -- verified against the real solana-loader-v3-interface
 * enum, not guessed.
 */
const UPGRADE_DISCRIMINATOR = [3, 0, 0, 0];

/**
 * Account order for the Upgrade instruction, per the loader's own
 * instruction processor: [0] ProgramData, [1] Program, [2] Buffer,
 * [3] spill, [4] Rent sysvar, [5] Clock sysvar, [6] authority (signer).
 */
const PROGRAM_ACCOUNT_INDEX = 1;
const BUFFER_ACCOUNT_INDEX = 2;
const BUFFER_METADATA_SIZE = 37;
const BUFFER_STATE_DISCRIMINATOR = 1;

/** verify.osec.io's remote verification only covers mainnet -- confirmed on solana.com/docs/programs/verified-builds ("Remote verification will only work on mainnet"), not assumed. */
export const SUPPORTED_VERIFICATION_CLUSTER = "mainnet-beta" as const;

export type KnownSolanaCluster = "mainnet-beta" | "devnet" | "testnet";

/** Accepts only an explicit, known cluster name -- anything else (missing, typo'd, custom) resolves to undefined so callers fail closed rather than silently assuming mainnet. */
export function parseKnownCluster(value: string | undefined): KnownSolanaCluster | undefined {
  if (value === "mainnet-beta" || value === "devnet" || value === "testnet") return value;
  return undefined;
}

export interface DetectedUpgrade {
  targetProgramId: string;
  bufferAddress: string;
}

export type BufferBytecodeEvidence =
  | { outcome: "HASHED"; sha256: string; bytesHashed: number }
  | { outcome: "UNAVAILABLE"; reason: string };

/**
 * Returns evidence about the exact bytes currently held in a pending upgrade
 * buffer. This is deliberately not verified-build status: it only gives a
 * reviewer a reproducible fingerprint to compare with a separately trusted
 * deterministic build. The layout and trailing-zero treatment match
 * solana-verify's public get-buffer-hash implementation.
 */
export async function getBufferBytecodeEvidence(connection: Connection, bufferAddress: PublicKey): Promise<BufferBytecodeEvidence> {
  let account;
  try {
    account = await connection.getAccountInfo(bufferAddress);
  } catch (error) {
    return { outcome: "UNAVAILABLE", reason: `RPC failure reading pending buffer ${bufferAddress.toBase58()}: ${(error as Error).message}` };
  }
  if (!account) return { outcome: "UNAVAILABLE", reason: `Pending buffer ${bufferAddress.toBase58()} could not be found.` };
  if (!account.owner.equals(BPF_UPGRADEABLE_LOADER_PROGRAM_ID)) {
    return {
      outcome: "UNAVAILABLE",
      reason: `Pending buffer ${bufferAddress.toBase58()} is owned by ${account.owner.toBase58()}, not the BPF Upgradeable Loader.`
    };
  }
  if (account.data.length < BUFFER_METADATA_SIZE || account.data.readUInt32LE(0) !== BUFFER_STATE_DISCRIMINATOR) {
    return { outcome: "UNAVAILABLE", reason: `Pending buffer ${bufferAddress.toBase58()} does not contain a valid upgradeable-loader Buffer header.` };
  }

  const programBytes = account.data.subarray(BUFFER_METADATA_SIZE);
  let executableEnd = programBytes.length;
  while (executableEnd > 0 && programBytes[executableEnd - 1] === 0) executableEnd -= 1;
  const executableBytes = programBytes.subarray(0, executableEnd);
  return {
    outcome: "HASHED",
    sha256: createHash("sha256").update(executableBytes).digest("hex"),
    bytesHashed: executableBytes.length
  };
}

interface CompiledMessageLike {
  accountKeys: PublicKey[];
  instructions: { programIdIndex: number; accountIndexes: Uint8Array; data: Uint8Array }[];
}

/**
 * Scans a fully-resolved instruction list for a BPF Upgradeable Loader
 * Upgrade instruction. The caller is responsible for ensuring
 * `message.accountKeys` is the *complete* resolved key list (static
 * keys plus any Address Lookup Table entries) -- this function trusts
 * its input and does not itself know whether resolution succeeded.
 */
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

export type AltResolutionResult = { resolved: true; accountKeys: PublicKey[] } | { resolved: false; reason: string };

interface AddressTableLookupLike {
  accountKey: PublicKey;
  writableIndexes: Uint8Array;
  readonlyIndexes: Uint8Array;
}

/**
 * Resolves a Squads VaultTransactionMessage's full account-key space:
 * static keys, then every writable Address Lookup Table entry (table
 * order, then index order), then every readonly entry (same order) --
 * the same convention Solana's own versioned-message format uses, which
 * Squads' addressTableLookups is deliberately modeled on (confirmed
 * against @sqds/multisig's own compiled-keys source comment). Fails
 * closed on any missing table, out-of-range index, or RPC failure --
 * never silently falls back to the static-only subset, which is what
 * produced false NOT_AN_UPGRADE results before this fix.
 */
export async function resolveFullAccountKeys(
  connection: Connection,
  staticAccountKeys: PublicKey[],
  addressTableLookups: AddressTableLookupLike[]
): Promise<AltResolutionResult> {
  if (addressTableLookups.length === 0) {
    return { resolved: true, accountKeys: staticAccountKeys };
  }

  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of addressTableLookups) {
    let table: AddressLookupTableAccount | null;
    try {
      table = (await connection.getAddressLookupTable(lookup.accountKey)).value;
    } catch (error) {
      return {
        resolved: false,
        reason: `RPC failure resolving address lookup table ${lookup.accountKey.toBase58()}: ${(error as Error).message}`
      };
    }
    if (!table) {
      return { resolved: false, reason: `Address lookup table ${lookup.accountKey.toBase58()} could not be found.` };
    }
    tables.push(table);
  }

  const writable: PublicKey[] = [];
  const readonly: PublicKey[] = [];
  for (let i = 0; i < addressTableLookups.length; i++) {
    const lookup = addressTableLookups[i]!;
    const table = tables[i]!;
    for (const index of lookup.writableIndexes) {
      const address = table.state.addresses[index];
      if (!address) {
        return { resolved: false, reason: `Writable index ${index} is out of bounds for lookup table ${lookup.accountKey.toBase58()}.` };
      }
      writable.push(address);
    }
    for (const index of lookup.readonlyIndexes) {
      const address = table.state.addresses[index];
      if (!address) {
        return { resolved: false, reason: `Readonly index ${index} is out of bounds for lookup table ${lookup.accountKey.toBase58()}.` };
      }
      readonly.push(address);
    }
  }

  return { resolved: true, accountKeys: [...staticAccountKeys, ...writable, ...readonly] };
}

export type VerificationOutcome = "VERIFIED" | "UNVERIFIED" | "UNKNOWN";

export interface VerifiedBuildStatus {
  outcome: VerificationOutcome;
  /** null when the configured cluster isn't one verify.osec.io evidence can be attributed to. */
  cluster: typeof SUPPORTED_VERIFICATION_CLUSTER | null;
  repoUrl?: string;
  lastVerifiedAt?: string;
  onChainHash?: string;
  /** Populated for UNKNOWN -- why the outcome couldn't be determined, never presented as a confirmed absence of verification. */
  reason?: string;
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const VERIFY_API_TIMEOUT_MS = 5000;

function isValidStatusBody(
  body: unknown
): body is { is_verified: boolean; repo_url?: string; last_verified_at?: string | null; on_chain_hash?: string } {
  if (typeof body !== "object" || body === null) return false;
  return typeof (body as Record<string, unknown>).is_verified === "boolean";
}

/**
 * Checks a program's verification history via OtterSec's real, hosted
 * verify.osec.io API -- tri-state, not a boolean, so a provider outage
 * can never be presented as "no verified-build record" (a real
 * difference: one is "nobody has verified this," the other is "we don't
 * know"). Cluster-bound: verify.osec.io's remote verification is
 * mainnet-only, so any other configured cluster returns UNKNOWN without
 * even making the request, rather than attributing mainnet evidence to
 * a devnet or custom-RPC proposal.
 */
export async function checkProgramVerificationHistory(
  programId: string,
  cluster: KnownSolanaCluster | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<VerifiedBuildStatus> {
  if (cluster !== SUPPORTED_VERIFICATION_CLUSTER) {
    return {
      outcome: "UNKNOWN",
      cluster: null,
      reason: `verify.osec.io only covers ${SUPPORTED_VERIFICATION_CLUSTER}; the configured cluster is ${cluster ?? "unset or unrecognized"}, so no verification evidence can be attributed to this proposal.`
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_API_TIMEOUT_MS);
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchImpl(`https://verify.osec.io/status/${programId}`, { signal: controller.signal });
  } catch (error) {
    const isTimeout = (error as Error).name === "AbortError";
    return {
      outcome: "UNKNOWN",
      cluster: SUPPORTED_VERIFICATION_CLUSTER,
      reason: isTimeout
        ? `verify.osec.io did not respond within ${VERIFY_API_TIMEOUT_MS}ms.`
        : `verify.osec.io request failed: ${(error as Error).message}`
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      outcome: "UNKNOWN",
      cluster: SUPPORTED_VERIFICATION_CLUSTER,
      reason: `verify.osec.io returned HTTP ${response.status}; verification status could not be determined.`
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: "UNKNOWN", cluster: SUPPORTED_VERIFICATION_CLUSTER, reason: `verify.osec.io returned invalid JSON: ${(error as Error).message}` };
  }

  if (!isValidStatusBody(body)) {
    return { outcome: "UNKNOWN", cluster: SUPPORTED_VERIFICATION_CLUSTER, reason: "verify.osec.io response did not match the expected schema." };
  }

  return {
    outcome: body.is_verified ? "VERIFIED" : "UNVERIFIED",
    cluster: SUPPORTED_VERIFICATION_CLUSTER,
    repoUrl: body.repo_url || undefined,
    lastVerifiedAt: body.last_verified_at ?? undefined,
    onChainHash: body.on_chain_hash || undefined
  };
}

const U64_MAX = 2n ** 64n - 1n;

/** Accepts only a non-negative integer within u64 range -- rejects fractions, negatives, unsafe JS numbers, and malformed strings. Returns undefined on any invalid input rather than throwing, so callers can map it to a 400. */
export function parseTransactionIndex(value: string | number): bigint | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) return undefined;
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return undefined;
    const parsed = BigInt(value);
    if (parsed > U64_MAX) return undefined;
    return parsed;
  }
  return undefined;
}

export type SquadsUpgradeEvaluation =
  | { decision: "NOT_AN_UPGRADE"; cluster: KnownSolanaCluster | undefined; reasons: string[] }
  | { decision: "ANALYSIS_INCOMPLETE"; cluster: KnownSolanaCluster | undefined; reasons: string[] }
  | { decision: "NOT_PENDING"; cluster: KnownSolanaCluster | undefined; proposalStatus: string; reasons: string[] }
  | {
      decision: "NEEDS_REVIEW";
      cluster: KnownSolanaCluster | undefined;
      targetProgramId: string;
      bufferAddress: string;
      proposalStatus: string;
      verificationHistory: VerifiedBuildStatus;
      bufferBytecodeEvidence: BufferBytecodeEvidence;
      reasons: string[];
    };

/** Active and Approved are the only states where a signer's review/action is still meaningful: Active is open for voting, Approved has quorum but hasn't executed. Draft (not yet opened), Rejected, Executing, Executed, and Cancelled are all states where flagging "needs review" would be misleading. */
function isPendingProposalStatus(kind: string): boolean {
  return kind === "Active" || kind === "Approved";
}

/**
 * The gap this fills: a Squads signer gets no automated context before
 * approving a program upgrade today -- verification is a manual,
 * external CLI step nothing in Squads' own UI surfaces. This doesn't
 * close that gap entirely (see checkProgramVerificationHistory's own
 * cluster and tri-state caveats), but it's a real improvement over the
 * blank signing screen that exists right now.
 *
 * `trustedSquadsProgramId` is deliberately not requester-controlled --
 * it comes from server-side config (defaulting to the real Squads V4
 * program), so a caller can't redirect which program's accounts are
 * trusted by passing an arbitrary program ID in the request body.
 */
export async function evaluateSquadsUpgradeProposal(
  connection: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  cluster: KnownSolanaCluster | undefined,
  trustedSquadsProgramId: PublicKey = SQUADS_PROGRAM_ID,
  fetchImpl?: FetchLike
): Promise<SquadsUpgradeEvaluation> {
  const [transactionPda] = getTransactionPda({ multisigPda, index: transactionIndex, programId: trustedSquadsProgramId });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex, programId: trustedSquadsProgramId });

  const [transactionAccountInfo, proposalAccountInfo] = await Promise.all([
    connection.getAccountInfo(transactionPda),
    connection.getAccountInfo(proposalPda)
  ]);

  if (!transactionAccountInfo) {
    return { decision: "ANALYSIS_INCOMPLETE", cluster, reasons: [`No VaultTransaction account found at ${transactionPda.toBase58()}.`] };
  }
  if (!proposalAccountInfo) {
    return { decision: "ANALYSIS_INCOMPLETE", cluster, reasons: [`No Proposal account found at ${proposalPda.toBase58()}. A VaultTransaction without a Proposal can't be assessed for review status.`] };
  }
  if (!transactionAccountInfo.owner.equals(trustedSquadsProgramId)) {
    return { decision: "ANALYSIS_INCOMPLETE", cluster, reasons: [`VaultTransaction account ${transactionPda.toBase58()} is owned by ${transactionAccountInfo.owner.toBase58()}, not the trusted Squads program ${trustedSquadsProgramId.toBase58()}.`] };
  }
  if (!proposalAccountInfo.owner.equals(trustedSquadsProgramId)) {
    return { decision: "ANALYSIS_INCOMPLETE", cluster, reasons: [`Proposal account ${proposalPda.toBase58()} is owned by ${proposalAccountInfo.owner.toBase58()}, not the trusted Squads program ${trustedSquadsProgramId.toBase58()}.`] };
  }

  const [vaultTransaction] = accounts.VaultTransaction.fromAccountInfo(transactionAccountInfo);
  const [proposal] = accounts.Proposal.fromAccountInfo(proposalAccountInfo);

  if (!vaultTransaction.multisig.equals(multisigPda) || BigInt(vaultTransaction.index.toString()) !== transactionIndex) {
    return { decision: "ANALYSIS_INCOMPLETE", cluster, reasons: ["VaultTransaction account's embedded multisig/index does not match the requested multisig and transaction index."] };
  }
  if (!proposal.multisig.equals(multisigPda) || BigInt(proposal.transactionIndex.toString()) !== transactionIndex) {
    return { decision: "ANALYSIS_INCOMPLETE", cluster, reasons: ["Proposal account's embedded multisig/transactionIndex does not match the requested multisig and transaction index."] };
  }

  const statusKind = proposal.status.__kind;
  if (!isPendingProposalStatus(statusKind)) {
    return {
      decision: "NOT_PENDING",
      cluster,
      proposalStatus: statusKind,
      reasons: [`This proposal's status is ${statusKind}, not Active or Approved -- there is no pending signer decision for this to inform.`]
    };
  }

  const resolution = await resolveFullAccountKeys(connection, vaultTransaction.message.accountKeys, vaultTransaction.message.addressTableLookups);
  if (!resolution.resolved) {
    return { decision: "ANALYSIS_INCOMPLETE", cluster, reasons: [resolution.reason] };
  }

  const detected = detectUpgradeInstruction({ accountKeys: resolution.accountKeys, instructions: vaultTransaction.message.instructions });
  if (!detected) {
    return { decision: "NOT_AN_UPGRADE", cluster, reasons: ["This proposal does not contain a BPF Upgradeable Loader Upgrade instruction."] };
  }

  const [verificationHistory, bufferBytecodeEvidence] = await Promise.all([
    checkProgramVerificationHistory(detected.targetProgramId, cluster, fetchImpl),
    getBufferBytecodeEvidence(connection, new PublicKey(detected.bufferAddress))
  ]);
  const reasons: string[] = [];
  if (verificationHistory.outcome === "VERIFIED") {
    reasons.push(
      `Program ${detected.targetProgramId} was last verified against ${verificationHistory.repoUrl ?? "an unrecorded repository"} on ${verificationHistory.lastVerifiedAt ?? "an unrecorded date"}. That reflects the program's history, not the pending buffer -- confirm buffer ${detected.bufferAddress} has itself been verified against an updated commit before approving.`
    );
  } else if (verificationHistory.outcome === "UNVERIFIED") {
    reasons.push(
      `Program ${detected.targetProgramId} has no verified-build record on file. Approving this upgrade means trusting bytecode with no independent source match on record.`
    );
  } else {
    reasons.push(`Verification status for ${detected.targetProgramId} is unknown: ${verificationHistory.reason}`);
  }
  if (bufferBytecodeEvidence.outcome === "HASHED") {
    reasons.push(
      `Pending buffer ${detected.bufferAddress} has SHA-256 ${bufferBytecodeEvidence.sha256} over ${bufferBytecodeEvidence.bytesHashed} executable bytes. This is a fingerprint, not verified-build status; compare it with a separately trusted deterministic build before approving.`
    );
  } else {
    reasons.push(`Pending buffer bytecode fingerprint is unavailable: ${bufferBytecodeEvidence.reason}`);
  }

  return {
    decision: "NEEDS_REVIEW",
    cluster,
    targetProgramId: detected.targetProgramId,
    bufferAddress: detected.bufferAddress,
    proposalStatus: statusKind,
    verificationHistory,
    bufferBytecodeEvidence,
    reasons
  };
}
