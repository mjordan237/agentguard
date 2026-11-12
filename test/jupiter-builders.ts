import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM } from "../src/agent-integration/standard-programs.js";
import { ASSOCIATED_TOKEN_PROGRAM } from "../src/agent-integration/payment-extras.js";
import { JUPITER_V6_PROGRAM } from "../src/agent-integration/jupiter.js";
import { associatedTokenAccount, WRAPPED_SOL_MINT } from "../src/policy/swap-rules.js";

/** Builders for Jupiter v6 swap transactions, laid out from the pinned IDL. Shared by the swap tests. */
export const EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUP = new PublicKey(JUPITER_V6_PROGRAM);

export const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

export interface SwapArgs { inAmount?: bigint; quotedOut?: bigint; slippageBps?: number; platformFeeBps?: number; positiveSlippageBps?: number; shares?: number[]; trailing?: Buffer; variant?: number }

/** route_v2 data: the amounts first, then the plan. Variant 0 (Saber) carries no fields. */
export function routeV2Data(a: SwapArgs = {}) {
  const shares = a.shares ?? [10_000];
  const plan = Buffer.concat([u32(shares.length), ...shares.map((bps) => Buffer.concat([u8(a.variant ?? 0), u16(bps), u8(0), u8(1)]))]);
  return Buffer.concat([discriminator("route_v2"), u64(a.inAmount ?? 1_000_000_000n), u64(a.quotedOut ?? 150_000_000n), u16(a.slippageBps ?? 50), u16(a.platformFeeBps ?? 0), u16(a.positiveSlippageBps ?? 0), plan, a.trailing ?? Buffer.alloc(0)]);
}

/** Legacy route data: the plan first, then the amounts. */
export function routeData(a: SwapArgs = {}) {
  const shares = a.shares ?? [100];
  const plan = Buffer.concat([u32(shares.length), ...shares.map((percent) => Buffer.concat([u8(a.variant ?? 0), u8(percent), u8(0), u8(1)]))]);
  return Buffer.concat([discriminator("route"), plan, u64(a.inAmount ?? 1_000_000_000n), u64(a.quotedOut ?? 150_000_000n), u16(a.slippageBps ?? 50), u8(a.platformFeeBps ?? 0), a.trailing ?? Buffer.alloc(0)]);
}

export const meta = (pubkey: PublicKey | string, isSigner = false, isWritable = false) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable });
export const ata = (owner: PublicKey, mint: string) => new PublicKey(associatedTokenAccount(owner.toBase58(), TOKEN_PROGRAM, mint)!);

export interface Built { agent: PublicKey; instructions: TransactionInstruction[] }

/** Sell 1 SOL for USDC the way Jupiter's API builds it: create the ATAs, wrap SOL, swap, unwrap. */
export function sellSol(options: { args?: SwapArgs; legacy?: boolean; destination?: PublicKey; wrapTo?: PublicKey; closeTo?: PublicKey } = {}): Built {
  const agent = Keypair.generate().publicKey;
  const wsolAta = ata(agent, WRAPPED_SOL_MINT);
  const usdcAta = ata(agent, USDC);
  const dex = Keypair.generate().publicKey;
  const createAta = (mint: string, account: PublicKey) => new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM), data: Buffer.from([1]),
    keys: [meta(agent, true, true), meta(account, false, true), meta(agent), meta(mint), meta(SystemProgram.programId), meta(TOKEN_PROGRAM)]
  });
  const swap = options.legacy
    ? new TransactionInstruction({ programId: JUP, data: routeData(options.args), keys: [
        meta(TOKEN_PROGRAM), meta(agent, true), meta(wsolAta, false, true), meta(options.destination ?? usdcAta, false, true), meta(JUP), meta(USDC), meta(JUP), meta(EVENT_AUTHORITY), meta(JUP), meta(dex, false, true)] })
    : new TransactionInstruction({ programId: JUP, data: routeV2Data(options.args), keys: [
        meta(agent, true), meta(wsolAta, false, true), meta(options.destination ?? usdcAta, false, true), meta(WRAPPED_SOL_MINT), meta(USDC), meta(TOKEN_PROGRAM), meta(TOKEN_PROGRAM), meta(JUP), meta(EVENT_AUTHORITY), meta(JUP), meta(dex, false, true)] });
  return {
    agent,
    instructions: [
      createAta(WRAPPED_SOL_MINT, wsolAta),
      createAta(USDC, usdcAta),
      SystemProgram.transfer({ fromPubkey: agent, toPubkey: options.wrapTo ?? wsolAta, lamports: 1_000_000_000 }),
      new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data: Buffer.from([17]), keys: [meta(wsolAta, false, true)] }),
      swap,
      new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data: Buffer.from([9]), keys: [meta(wsolAta, false, true), meta(options.closeTo ?? agent, false, true), meta(agent, true)] })
    ]
  };
}
