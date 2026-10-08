import type { Connection } from "@solana/web3.js";
import type { KnownSolanaCluster } from "../gateway/squads-upgrade-gate.js";

export const SOLANA_GENESIS_HASHES: Record<KnownSolanaCluster, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
};

export interface NetworkDetection {
  genesisHash: string;
  detectedCluster: KnownSolanaCluster | undefined;
}

/** Measures the RPC endpoint's identity; no configured cluster name is trusted here. */
export async function detectSolanaNetwork(connection: Pick<Connection, "getGenesisHash">): Promise<NetworkDetection> {
  const genesisHash = await connection.getGenesisHash();
  const detectedCluster = (Object.entries(SOLANA_GENESIS_HASHES).find(([, hash]) => hash === genesisHash)?.[0] as KnownSolanaCluster | undefined);
  return { genesisHash, detectedCluster };
}

/** Builds startup output from measured RPC identity, with configuration shown only for comparison. */
export function networkStartupLines(detection: NetworkDetection, configuredCluster: KnownSolanaCluster | undefined): string[] {
  const lines: string[] = [];
  if (detection.detectedCluster === "mainnet-beta") {
    lines.push("============================================================");
    lines.push("!!! MAINNET-BETA DETECTED: REAL ASSETS AND PROGRAMS !!!");
    lines.push(`!!! Genesis hash: ${detection.genesisHash}`);
    lines.push("============================================================");
  } else if (detection.detectedCluster) {
    lines.push(`=== ${detection.detectedCluster.toUpperCase()} DETECTED === Genesis hash: ${detection.genesisHash}`);
  } else {
    lines.push(`!!! UNKNOWN SOLANA NETWORK DETECTED !!! Genesis hash: ${detection.genesisHash}`);
    lines.push("No known cluster label is being assumed for this RPC endpoint.");
  }

  if (configuredCluster !== undefined && configuredCluster !== detection.detectedCluster) {
    lines.push(
      `WARNING: SOLANA_CLUSTER is configured as ${configuredCluster ?? "unset or unrecognized"}, but RPC genesis hash measured ${detection.detectedCluster ?? "an unknown network"}.`
    );
  }
  return lines;
}
