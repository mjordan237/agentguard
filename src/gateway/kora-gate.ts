import { VersionedTransaction } from "@solana/web3.js";
import { KoraClient, type SignAndSendTransactionResponse } from "@solana/kora";

export interface KoraGateConfig {
  client: KoraClient;
}

/**
 * The requester built a transaction whose fee payer isn't Kora's own
 * configured signer. Kora's signing model keeps the fee payer and the
 * value-transfer authority as two separate roles (confirmed against real,
 * live Kora instances on both devnet and mainnet -- see
 * scripts/kora-live-test/); a transaction built with anything else in the
 * fee-payer slot either fails at Kora or, worse, would need Kora's signer
 * to also be a transfer source, which Kora's own config validator warns
 * against allowing. This is a requester error, not a Kora-side failure --
 * the caller needs to rebuild the transaction correctly.
 */
export class KoraFeePayerMismatchError extends Error {
  constructor(public readonly expected: string, public readonly actual: string | undefined) {
    super(
      `Transaction's fee payer (${actual ?? "unknown"}) does not match Kora's configured signer (${expected}). ` +
        "Build the transaction with Kora's signer as the fee payer and the agent as a separate instruction-level signer."
    );
    this.name = "KoraFeePayerMismatchError";
  }
}

/**
 * Only ever called after policy has already returned ALLOW -- never for
 * NEEDS_REVIEW. Validates the transaction's fee payer against Kora's real
 * configured signer before forwarding, then signs AND submits -- not
 * sign-only. By the time a transaction reaches this point it should
 * already carry the agent's own signature (they authorized the transfer
 * before it was ever evaluated); Kora's signature is the last one needed,
 * so there's no reason to withhold submission once it's added.
 */
export async function signThroughKora(config: KoraGateConfig, transactionBase64: string): Promise<SignAndSendTransactionResponse> {
  const { signer_address } = await config.client.getPayerSigner();

  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
  const feePayerInTx = tx.message.staticAccountKeys[0]?.toBase58();
  if (feePayerInTx !== signer_address) {
    throw new KoraFeePayerMismatchError(signer_address, feePayerInTx);
  }

  return config.client.signAndSendTransaction({ transaction: transactionBase64 });
}
