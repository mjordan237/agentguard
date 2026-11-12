import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { normalizeAddress, type EvmTransaction } from "./decode.js";

/** A transaction with everything needed to sign it (EIP-1559, type 2). */
export interface SignableEvmTransaction extends EvmTransaction {
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Where the signature comes from. The gate only calls this after policy has said ALLOW (or a person has
 * approved this exact transaction). Production custody (a KMS, an HSM, a smart-account co-signer) plugs in
 * behind this interface; LocalKeySigner is for tests and supervised pilots.
 */
export interface EvmSigner {
  readonly address: string;
  /** Returns the raw signed transaction, 0x-hex, ready for eth_sendRawTransaction. */
  signTransaction(tx: SignableEvmTransaction): Promise<string>;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// ---- RLP (https://ethereum.org/developers/docs/data-structures-and-encoding/rlp) ----
type Rlp = Uint8Array | Rlp[];

function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const be = bigEndian(BigInt(length));
  return Uint8Array.of(offset + 55 + be.length, ...be);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function rlp(item: Rlp): Uint8Array {
  if (Array.isArray(item)) {
    const body = concat(item.map(rlp));
    return concat([lengthPrefix(body.length, 0xc0), body]);
  }
  if (item.length === 1 && item[0] < 0x80) return item;
  return concat([lengthPrefix(item.length, 0x80), item]);
}

/** Minimal big-endian bytes; zero is the empty string, as RLP integers require. */
function bigEndian(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("negative integer");
  if (n === 0n) return new Uint8Array(0);
  const h = n.toString(16);
  return Uint8Array.from(Buffer.from(h.length % 2 ? `0${h}` : h, "hex"));
}

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

function payload(tx: SignableEvmTransaction): Rlp[] {
  const to = tx.to === undefined ? undefined : normalizeAddress(tx.to);
  if (tx.to !== undefined && to === undefined) throw new Error("invalid recipient");
  const data = (tx.data ?? "0x").toLowerCase();
  if (!/^0x([0-9a-f]{2})*$/.test(data)) throw new Error("invalid calldata");
  return [
    bigEndian(BigInt(tx.chainId)), bigEndian(tx.nonce), bigEndian(tx.maxPriorityFeePerGas), bigEndian(tx.maxFeePerGas),
    bigEndian(tx.gasLimit), to === undefined ? new Uint8Array(0) : fromHex(to), bigEndian(tx.value ?? 0n), fromHex(data), []
  ];
}

/** keccak256(0x02 || rlp(payload)): the digest a type-2 transaction signs. */
export function eip1559SigningHash(tx: SignableEvmTransaction): Uint8Array {
  return keccak_256(concat([Uint8Array.of(0x02), rlp(payload(tx))]));
}

export function addressOfKey(privateKey: Uint8Array): string {
  return `0x${hex(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1))).slice(24)}`;
}

/** Signs with a private key held in memory. Not custody: use only where the key may sit next to the gate. */
export class LocalKeySigner implements EvmSigner {
  readonly address: string;
  constructor(private readonly privateKey: Uint8Array) { this.address = addressOfKey(privateKey); }

  async signTransaction(tx: SignableEvmTransaction): Promise<string> {
    if (normalizeAddress(tx.from) !== this.address) throw new Error(`Transaction is from ${tx.from}, but this signer controls ${this.address}.`);
    const signature = secp256k1.sign(eip1559SigningHash(tx), this.privateKey);
    const signed = rlp([...payload(tx), bigEndian(BigInt(signature.recovery)), bigEndian(signature.r), bigEndian(signature.s)]);
    return `0x02${hex(signed)}`;
  }
}
