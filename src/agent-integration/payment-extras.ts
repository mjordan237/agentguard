import { PublicKey } from "@solana/web3.js";
import type { DecodedInstructionSummary } from "../policy/types.js";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./standard-programs.js";

export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_PROGRAM_V1 = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RECENT_BLOCKHASHES_SYSVAR = "SysvarRecentB1ockHashes11111111111111111111";
/** System instruction 4, AdvanceNonceAccount, as a little-endian u32. */
const ADVANCE_NONCE = [4, 0, 0, 0];
const MAX_MEMO_BYTES = 566;

const dump = (programId: string, name: string, reason: string, accounts: string[]): DecodedInstructionSummary =>
  ({ programId, instructionName: name, fields: { reason }, mode: "raw_dump", accounts });

/** Memo text is shown to reviewers (and to an advisory language model), so it is cut short and stripped of control characters. */
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
const displayMemo = (text: string) => {
  const clean = text.replace(CONTROL_CHARACTERS, "?");
  return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean;
};

/**
 * Two instructions that appear in many ordinary payments and carry no authority of their own.
 *
 *  - Associated Token Account creation (legacy Create, empty data; CreateIdempotent, data [1]). The account
 *    being created is re-derived here from owner, token program and mint, and must match the instruction's
 *    account exactly, so the instruction cannot claim an address that does not belong to that owner. The
 *    created account is the policy destination, the same way a transferChecked destination is the token
 *    account: allowlist the account and both the creation and the transfer pass. RecoverNested and any
 *    unexpected data or account layout go to review.
 *  - Memo (v1 and v2): UTF-8 text, at most 566 bytes. Moves nothing.
 *
 *  - Durable nonce advance (System AdvanceNonceAccount): makes a transaction use a stored nonce instead of a
 *    recent blockhash, so it stays valid while a person reviews it and can still land only once. Moves nothing;
 *    evaluatePolicy checks where it sits in the transaction.
 *
 * Returns undefined for anything else, so the normal registry path handles it.
 */
export function decodePaymentExtras(programId: string, accounts: string[], data: Uint8Array): DecodedInstructionSummary | undefined {
  if (programId === SYSTEM_PROGRAM && data.length === 4 && ADVANCE_NONCE.every((byte, index) => data[index] === byte)) {
    if (accounts.length !== 3) return dump(programId, "advanceNonceAccount", `Expected 3 accounts, found ${accounts.length}.`, accounts);
    const [nonceAccount, sysvar, authority] = accounts;
    if (sysvar !== RECENT_BLOCKHASHES_SYSVAR) return dump(programId, "advanceNonceAccount", "The second account is not the RecentBlockhashes sysvar.", accounts);
    return { programId, instructionName: "advanceNonceAccount", fields: { nonceAccount, authority }, mode: "interpolated", accounts };
  }

  if (programId === MEMO_PROGRAM || programId === MEMO_PROGRAM_V1) {
    if (data.length > MAX_MEMO_BYTES) return dump(programId, "memo", `The memo is ${data.length} bytes, over the ${MAX_MEMO_BYTES}-byte limit.`, accounts);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return dump(programId, "memo", "The memo is not valid UTF-8.", accounts); }
    return { programId, instructionName: "memo", fields: { memo: displayMemo(text), bytes: data.length }, mode: "interpolated", accounts };
  }

  if (programId !== ASSOCIATED_TOKEN_PROGRAM) return undefined;
  const idempotent = data.length === 1 && data[0] === 1;
  const legacy = data.length === 0 || (data.length === 1 && data[0] === 0);
  if (!idempotent && !legacy) return dump(programId, "unknown", "Only Create and CreateIdempotent of the associated token program are understood.", accounts);
  const name = idempotent ? "createIdempotent" : "create";
  if (accounts.length !== 6) return dump(programId, name, `Expected 6 accounts, found ${accounts.length}.`, accounts);
  const [funder, account, owner, mint, systemProgram, tokenProgram] = accounts;
  if (systemProgram !== SYSTEM_PROGRAM) return dump(programId, name, "The system program account is not the System Program.", accounts);
  if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) return dump(programId, name, "The token program account is not SPL Token or Token-2022.", accounts);
  let expected: string;
  try {
    expected = PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM))[0].toBase58();
  } catch { return dump(programId, name, "An account address is not valid.", accounts); }
  if (account !== expected) return dump(programId, name, `The account ${account} is not the associated token account of ${owner} for mint ${mint} (expected ${expected}).`, accounts);
  return { programId, instructionName: name, fields: { funder, owner, mint, account, tokenProgram }, mode: "interpolated", accounts, destination: account };
}
