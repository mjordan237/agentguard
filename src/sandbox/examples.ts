import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";

/** Fixed seeds, so every server and every reader gets byte-identical examples and identical receipts. */
const key = (label: string) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (label.charCodeAt(i % label.length) + i) & 0xff)).publicKey;
const RELAYER = key("relayer"), AGENT = key("agent"), VENDOR = key("vendor"), STRANGER = key("stranger"), ATTACKER_PROGRAM = key("attacker-program");
const BLOCKHASH = key("example-blockhash").toBase58();

const transaction = (instructions: TransactionInstruction[]) =>
  Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: RELAYER, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message()).serialize()).toString("base64");
const pay = (to: PublicKey, sol: number) => SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: to, lamports: Math.round(sol * 1e9) });

const policy = {
  policyId: "vendor-payments",
  programAllowlist: [SystemProgram.programId.toBase58()],
  destinationAllowlist: [VENDOR.toBase58()],
  maxAmountPerTransaction: { native: "1000000000" },
  maxAmountPerDay: { native: "5000000000" }
};

/** Request bodies for POST /v1/check, each with the decision it should get. */
export function sandboxExamples() {
  const examples = [
    { name: "allowed-vendor-payment", expect: "ALLOW", about: "0.1 SOL to the one allowlisted vendor, within the limits.", body: { chain: "solana", transactionBase64: transaction([pay(VENDOR, 0.1)]), policy } },
    { name: "unknown-destination", expect: "NEEDS_REVIEW", about: "The same payment to an address the policy does not list.", body: { chain: "solana", transactionBase64: transaction([pay(STRANGER, 0.1)]), policy } },
    { name: "over-the-limit", expect: "NEEDS_REVIEW", about: "2 SOL to the vendor, over the 1 SOL per-transaction limit.", body: { chain: "solana", transactionBase64: transaction([pay(VENDOR, 2)]), policy } },
    { name: "hidden-instruction", expect: "NEEDS_REVIEW", about: "A clean payment with a second instruction that hands the agent's account to another program.", body: { chain: "solana", transactionBase64: transaction([pay(VENDOR, 0.1), SystemProgram.assign({ accountPubkey: AGENT, programId: ATTACKER_PROGRAM })]), policy } },
    { name: "daily-limit", expect: "NEEDS_REVIEW", about: "A payment within the per-transaction limit that would pass the day's total, given what was already spent.", body: { chain: "solana", transactionBase64: transaction([pay(VENDOR, 0.5)]), policy, spentToday: { native: "4800000000" } } },
    {
      name: "evm-transfer", expect: "ALLOW", about: "1 ETH to an allowlisted address on Ethereum mainnet.",
      body: {
        chain: "evm",
        transaction: { chainId: 1, from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", value: "1000000000000000000" },
        policy: { policyId: "evm-payments", programAllowlist: ["evm:native"], destinationAllowlist: ["0x2222222222222222222222222222222222222222"], allowedChainIds: [1], maxAmountPerTransaction: { native: "2000000000000000000" }, maxAmountPerDay: { native: "5000000000000000000" } }
      }
    }
  ];
  return { examples, accounts: { relayer: RELAYER.toBase58(), agent: AGENT.toBase58(), vendor: VENDOR.toBase58(), stranger: STRANGER.toBase58() } };
}
