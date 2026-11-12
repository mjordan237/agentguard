import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { DecodedTransactionSummary, SwapSummary } from "../policy/types.js";
import { assetKey, associatedTokenAccount, WRAPPED_SOL_MINT } from "../policy/swap-rules.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Most accounts a swap may name and still be simulated; more is unusual enough to send to a person. */
const MAX_OBSERVED_ACCOUNTS = 128;

export interface AccountState {
  /** The program that owns the account. */
  programOwner: string;
  lamports: bigint;
  data: Uint8Array;
}

export interface SimulationResult {
  err: unknown;
  logs?: string[];
  /** State after the transaction, in the order of the addresses asked for; null when the account does not exist. */
  accounts: (AccountState | null)[];
}

/** Reads accounts now, and simulates a transaction reporting the same accounts afterwards. */
export interface SwapSimulator {
  snapshot(addresses: string[]): Promise<(AccountState | null)[]>;
  simulate(transactionBase64: string, addresses: string[]): Promise<SimulationResult>;
}

interface TokenAccount { mint: string; owner: string; amount: bigint; delegate?: string }

/** The first 165 bytes of an SPL Token or Token-2022 account: mint, owner, amount, then an optional delegate. */
function tokenAccount(state: AccountState | null): TokenAccount | undefined {
  if (!state || (state.programOwner !== TOKEN_PROGRAM && state.programOwner !== TOKEN_2022_PROGRAM)) return undefined;
  const data = Buffer.from(state.data);
  // 165 bytes is a plain token account; a longer Token-2022 one carries the account type (2) at byte 165.
  if (data.length < 165 || (data.length > 165 && data[165] !== 2)) return undefined;
  return {
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
    ...(data.readUInt32LE(72) === 1 ? { delegate: new PublicKey(data.subarray(76, 108)).toBase58() } : {})
  };
}

const minimumOut = (swap: SwapSummary) => (swap.quotedOutAmount * BigInt(10_000 - Math.min(swap.slippageBps, 10_000))) / 10_000n;

export interface SimulationCheck {
  reasons: string[];
  /** Net change per asset across the swap signer's accounts ("native" is SOL, wrapped or not). */
  netChange: Record<string, string>;
}

/**
 * Simulates a transaction that contains swaps and checks what it does to the swap signer's own accounts, not just
 * what its instructions say: the decoder checks where the input comes from and where the output lands, but a route
 * names the accounts its DEX steps touch, and only running it shows what happens to them. Fails closed: a failed or
 * unavailable simulation is a reason, never a pass.
 */
export async function checkSwapsBySimulation(transactionBase64: string, decoded: DecodedTransactionSummary, simulator: SwapSimulator): Promise<SimulationCheck> {
  const swaps = decoded.instructions.flatMap((instruction) => (instruction.swap ? [instruction.swap] : []));
  if (swaps.length === 0) return { reasons: [], netChange: {} };
  const signers = new Set(swaps.map((swap) => swap.authority));
  if (signers.size > 1) return { reasons: ["Swaps signed by more than one account cannot be checked by simulation."], netChange: {} };
  const signer = swaps[0]!.authority;

  const addresses = [...new Set([signer, ...decoded.instructions.flatMap((instruction) => instruction.accounts)])].filter((address) => address !== "unknown");
  if (addresses.length > MAX_OBSERVED_ACCOUNTS) return { reasons: [`The transaction names ${addresses.length} accounts, more than the ${MAX_OBSERVED_ACCOUNTS} the simulation check reads.`], netChange: {} };

  let before: (AccountState | null)[];
  let after: SimulationResult;
  try {
    before = await simulator.snapshot(addresses);
    after = await simulator.simulate(transactionBase64, addresses);
  } catch (error) {
    return { reasons: [`The swap could not be simulated: ${(error as Error).message}`], netChange: {} };
  }
  if (after.err) return { reasons: [`The swap fails in simulation: ${JSON.stringify(after.err)}`], netChange: {} };
  if (before.length !== addresses.length || after.accounts.length !== addresses.length) return { reasons: ["The simulation did not report every account."], netChange: {} };

  const reasons: string[] = [];
  const net = new Map<string, bigint>();
  const add = (asset: string, amount: bigint) => net.set(asset, (net.get(asset) ?? 0n) + amount);
  addresses.forEach((address, index) => {
    const pre = before[index] ?? null, post = after.accounts[index] ?? null;
    const preToken = tokenAccount(pre), postToken = tokenAccount(post);
    const ownedBefore = address === signer || preToken?.owner === signer;
    const ownedAfter = address === signer || postToken?.owner === signer;
    if (preToken?.owner === signer && postToken && postToken.owner !== signer) reasons.push(`Token account ${address} stops belonging to the signer during the swap (new owner ${postToken.owner}).`);
    if (postToken?.owner === signer && postToken.delegate && postToken.delegate !== preToken?.delegate) reasons.push(`Token account ${address} gains a delegate, ${postToken.delegate}, who could spend from it later.`);
    if (!ownedBefore && !ownedAfter) return;
    // Every lamport of the signer's own accounts counts as SOL: wrapping, unwrapping, rent for its new token accounts
    // and closing them back all net out, so what remains is SOL that left or arrived.
    add("native", (post?.lamports ?? 0n) - (pre?.lamports ?? 0n));
    // Wrapped SOL is already counted through lamports; other tokens are counted by amount.
    const mint = (postToken ?? preToken)?.mint;
    if (mint && mint !== WRAPPED_SOL_MINT) add(mint, (ownedAfter ? postToken?.amount ?? 0n : 0n) - (ownedBefore ? preToken?.amount ?? 0n : 0n));
  });

  // What the swaps may spend, per asset, plus the network fee when the signer pays it.
  const allowance = new Map<string, bigint>();
  for (const swap of swaps) if (swap.sourceMint) allowance.set(assetKey(swap.sourceMint), (allowance.get(assetKey(swap.sourceMint)) ?? 0n) + swap.inAmount);
  if (decoded.feePayer === signer) {
    const signatures = BigInt(VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64")).message.header.numRequiredSignatures);
    allowance.set("native", (allowance.get("native") ?? 0n) + LAMPORTS_PER_SIGNATURE * signatures + (decoded.priorityFee ?? 0n));
  }
  // Legacy routes name no source mint; the policy matched one, and it is the only token allowed to go down.
  const unnamedSources = swaps.filter((swap) => !swap.sourceMint);

  // Output that lands with the signer counts toward the minimum; output sent elsewhere was checked by the policy.
  const expectedIn = new Map<string, bigint>();
  for (const swap of swaps) {
    const toSelf = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].some((program) => associatedTokenAccount(signer, program, swap.destinationMint) === swap.destinationTokenAccount);
    if (toSelf) expectedIn.set(assetKey(swap.destinationMint), (expectedIn.get(assetKey(swap.destinationMint)) ?? 0n) + minimumOut(swap));
  }

  // The unnamed input may be spent from one asset only: two assets going down cannot both be the same route's input.
  let unnamedLeft = unnamedSources.reduce((n, swap) => n + swap.inAmount, 0n);
  let unnamedUsedBy: string | undefined;
  for (const [asset, change] of net) {
    const gained = expectedIn.get(asset);
    if (change < 0n) {
      let allowed = allowance.get(asset) ?? 0n;
      if (-change > allowed && unnamedLeft > 0n && unnamedUsedBy === undefined) {
        unnamedUsedBy = asset;
        allowed += unnamedLeft;
        unnamedLeft = 0n;
      }
      if (-change > allowed) reasons.push(`In simulation the signer loses ${-change} of ${asset}, more than the ${allowed} the swap may spend.`);
    }
    if (gained !== undefined && change + (allowance.get(asset) ?? 0n) < gained) {
      reasons.push(`In simulation the signer receives ${change + (allowance.get(asset) ?? 0n)} of ${asset}, below the swap's guaranteed minimum of ${gained}.`);
    }
  }
  for (const [asset, gained] of expectedIn) {
    if (!net.has(asset) && gained > 0n) reasons.push(`In simulation the signer receives nothing of ${asset}; the swap guarantees at least ${gained}.`);
  }

  return { reasons, netChange: Object.fromEntries([...net].map(([asset, change]) => [asset, change.toString()])) };
}

/** A simulator backed by a Solana RPC. Both calls give up after `timeoutMs`, which the check treats as a failure. */
export function rpcSwapSimulator(connection: Connection, timeoutMs = 8_000): SwapSimulator {
  const timed = <T>(work: Promise<T>, what: string) => Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${timeoutMs} ms`)), timeoutMs))]);
  const state = (account: { owner: PublicKey | string; lamports: number; data: Buffer | [string, string] | string[] } | null): AccountState | null => {
    if (!account) return null;
    const data = Buffer.isBuffer(account.data) ? account.data : Buffer.from((account.data as string[])[0] ?? "", "base64");
    return { programOwner: typeof account.owner === "string" ? account.owner : account.owner.toBase58(), lamports: BigInt(account.lamports), data };
  };
  return {
    async snapshot(addresses) {
      const out: (AccountState | null)[] = [];
      for (let start = 0; start < addresses.length; start += 100) {
        const chunk = addresses.slice(start, start + 100).map((address) => new PublicKey(address));
        out.push(...(await timed(connection.getMultipleAccountsInfo(chunk, "confirmed"), "Reading accounts")).map((account) => state(account)));
      }
      return out;
    },
    async simulate(transactionBase64, addresses) {
      const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
      // A durable transaction must keep its nonce, which a replaced blockhash would break.
      const first = transaction.message.compiledInstructions[0];
      const durable = first !== undefined && transaction.message.staticAccountKeys[first.programIdIndex]?.toBase58() === "11111111111111111111111111111111" && Buffer.from(first.data).equals(Buffer.from([4, 0, 0, 0]));
      const result = await timed(connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: !durable, commitment: "confirmed", accounts: { encoding: "base64", addresses } }), "Simulation");
      return { err: result.value.err, logs: result.value.logs ?? undefined, accounts: (result.value.accounts ?? []).map((account) => state(account as never)) };
    }
  };
}
