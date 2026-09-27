import { KoraClient, type SignTransactionResponse } from "@solana/kora";

export interface KoraGateConfig {
  client: KoraClient;
}

/** Only ever called after policy has already returned ALLOW -- never for NEEDS_REVIEW. */
export async function signThroughKora(config: KoraGateConfig, transactionBase64: string): Promise<SignTransactionResponse> {
  return config.client.signTransaction({ transaction: transactionBase64 });
}
