import jupiterIdl from "./idl/jupiter-v6.json" with { type: "json" };
import { BorshReader, typeTable, type IdlType } from "./borsh-idl.js";
import type { DecodedInstructionSummary, SwapSummary } from "../policy/types.js";

export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";

interface IdlInstruction { name: string; discriminator: number[]; accounts: { name: string; optional?: boolean }[]; args: { name: string; type: IdlType }[] }
const idl = jupiterIdl as unknown as { address: string; instructions: IdlInstruction[]; types: Parameters<typeof typeTable>[0]["types"] };
const types = typeTable(idl);

/** Exact-in routes, where the input amount is fixed in the instruction. */
const SUPPORTED = new Set(["route", "shared_accounts_route", "route_v2", "shared_accounts_route_v2"]);
const WHY_NOT: Record<string, string> = {
  exact_out_route: "Exact-out routes are not supported yet: the input is bounded only by the quote and slippage.",
  shared_accounts_exact_out_route: "Exact-out routes are not supported yet: the input is bounded only by the quote and slippage.",
  exact_out_route_v2: "Exact-out routes are not supported yet: the input is bounded only by the quote and slippage.",
  shared_accounts_exact_out_route_v2: "Exact-out routes are not supported yet: the input is bounded only by the quote and slippage.",
  route_with_token_ledger: "Token-ledger routes take their input amount from a ledger account at run time, so the amount cannot be known from the transaction.",
  shared_accounts_route_with_token_ledger: "Token-ledger routes take their input amount from a ledger account at run time, so the amount cannot be known from the transaction."
};

const byDiscriminator = new Map(idl.instructions.map((instruction) => [Buffer.from(instruction.discriminator).toString("hex"), instruction]));

const dump = (name: string, reason: string, accounts: string[]): DecodedInstructionSummary =>
  ({ programId: JUPITER_V6_PROGRAM, instructionName: name, fields: { reason }, mode: "raw_dump", accounts });

/**
 * Decodes a Jupiter v6 swap from the pinned on-chain IDL (src/agent-integration/idl). Every argument is read,
 * the route plan included, and the data must end exactly where the arguments do: the program's deserializer
 * ignores trailing bytes, so reading the amounts from the end could disagree with what it executes.
 * Returns undefined for any other program.
 */
export function decodeJupiter(programId: string, accounts: string[], data: Uint8Array): DecodedInstructionSummary | undefined {
  if (programId !== JUPITER_V6_PROGRAM) return undefined;
  const instruction = data.length >= 8 ? byDiscriminator.get(Buffer.from(data.subarray(0, 8)).toString("hex")) : undefined;
  if (!instruction) return dump("unknown", "No Jupiter v6 instruction matches this data's discriminator.", accounts);
  if (!SUPPORTED.has(instruction.name)) return dump(instruction.name, WHY_NOT[instruction.name] ?? `Jupiter's ${instruction.name} is not a swap AgentGuard reads.`, accounts);
  if (accounts.length < instruction.accounts.length) {
    return dump(instruction.name, `Expected at least ${instruction.accounts.length} accounts, found ${accounts.length}.`, accounts);
  }

  let args: Record<string, unknown>;
  try {
    const reader = new BorshReader(data.subarray(8), types);
    args = reader.fields(instruction.args);
    if (reader.remaining !== 0) return dump(instruction.name, `${reader.remaining} byte(s) follow the arguments; refusing data the program would read differently.`, accounts);
  } catch (error) {
    return dump(instruction.name, `The arguments could not be read: ${(error as Error).message}.`, accounts);
  }

  // Anchor marks an omitted optional account by passing the program's own id in its place.
  const named = Object.fromEntries(instruction.accounts.map((account, index) => {
    const key = accounts[index]!;
    return [account.name, account.optional && key === JUPITER_V6_PROGRAM ? undefined : key];
  })) as Record<string, string | undefined>;
  if (named.event_authority !== EVENT_AUTHORITY) return dump(instruction.name, "The event authority account is not Jupiter's.", accounts);
  if (named.program !== JUPITER_V6_PROGRAM) return dump(instruction.name, "The program account is not Jupiter v6.", accounts);

  const plan = args.route_plan as Array<Record<string, unknown>>;
  if (plan.length === 0) return dump(instruction.name, "The route plan is empty.", accounts);
  const v2 = instruction.name.endsWith("_v2");
  // Each input is split across its steps; the shares from one input must add up to the whole of it.
  const whole = v2 ? 10_000 : 100;
  const shares = new Map<number, number>();
  for (const step of plan) shares.set(step.input_index as number, (shares.get(step.input_index as number) ?? 0) + ((v2 ? step.bps : step.percent) as number));
  for (const [input, total] of shares) {
    if (total !== whole) return dump(instruction.name, `Route plan steps from input ${input} add up to ${total} of ${whole}.`, accounts);
  }

  const shared = instruction.name.startsWith("shared_accounts");
  const destinationTokenAccount = shared ? named.destination_token_account : (named.destination_token_account ?? named.user_destination_token_account);
  const swap: SwapSummary = {
    router: "jupiter-v6",
    variant: instruction.name,
    authority: named.user_transfer_authority!,
    sourceTokenAccount: (shared ? named.source_token_account : named.user_source_token_account)!,
    ...(named.source_mint ? { sourceMint: named.source_mint } : {}),
    ...(named.source_token_program ? { sourceTokenProgram: named.source_token_program } : {}),
    ...(named.destination_token_program ? { destinationTokenProgram: named.destination_token_program } : {}),
    ...(named.token_program ? { tokenProgram: named.token_program } : {}),
    destinationTokenAccount: destinationTokenAccount!,
    destinationMint: named.destination_mint!,
    inAmount: args.in_amount as bigint,
    quotedOutAmount: args.quoted_out_amount as bigint,
    slippageBps: args.slippage_bps as number,
    platformFeeBps: args.platform_fee_bps as number,
    ...(named.platform_fee_account ? { platformFeeAccount: named.platform_fee_account } : {}),
    positiveSlippageBps: (args.positive_slippage_bps as number | undefined) ?? 0,
    steps: plan.length
  };

  return {
    programId,
    instructionName: instruction.name,
    mode: "interpolated",
    accounts,
    fields: {
      inAmount: swap.inAmount,
      quotedOutAmount: swap.quotedOutAmount,
      slippageBps: swap.slippageBps,
      platformFeeBps: swap.platformFeeBps,
      positiveSlippageBps: swap.positiveSlippageBps,
      sourceMint: swap.sourceMint ?? "(derived from the policy)",
      destinationMint: swap.destinationMint,
      destination: swap.destinationTokenAccount,
      steps: plan.map((step) => (typeof step.swap === "string" ? step.swap : Object.keys(step.swap as object)[0])).join(" > ")
    },
    destination: swap.destinationTokenAccount,
    swap
  };
}
