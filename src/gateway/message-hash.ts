import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";

const SIGNATURE_BYTES = 64;

/**
 * SHA-256 of a transaction's message bytes, excluding signatures, so a human approval is bound to what
 * will execute and not to who has signed it so far. Read straight from the wire format because web3.js
 * cannot re-serialize a version-1 message. Layouts (verified on real mainnet transactions):
 *   legacy / v0: shortvec(signature count) | signatures | message
 *   v1:          message | signatures   (first byte 0x81)
 * Returns undefined if the bytes are not a transaction, so callers fail closed instead of throwing.
 */
export function transactionMessageHash(transactionBase64: string): string | undefined {
  try {
    const raw = Buffer.from(transactionBase64, "base64");
    const transaction = VersionedTransaction.deserialize(raw);
    const signatureCount = transaction.signatures.length;
    const signatureBytes = signatureCount * SIGNATURE_BYTES;
    let message: Buffer;
    if (transaction.version === 1) {
      message = raw.subarray(0, raw.length - signatureBytes);
    } else {
      const countLength = signatureCount < 0x80 ? 1 : signatureCount < 0x4000 ? 2 : 3;
      message = raw.subarray(countLength + signatureBytes);
    }
    if (message.length === 0 || signatureBytes > raw.length) return undefined;
    return createHash("sha256").update(message).digest("hex");
  } catch {
    return undefined;
  }
}
