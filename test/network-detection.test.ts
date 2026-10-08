import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Connection } from "@solana/web3.js";
import { detectSolanaNetwork, networkStartupLines, SOLANA_GENESIS_HASHES } from "../src/network/cluster-detection.js";

function listen(server: http.Server): Promise<{ endpoint: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ endpoint: `http://localhost:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function startGenesisHashRpc(genesisHash: string) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const rpcRequest = JSON.parse(body) as { id: string | number; method: string };
      assert.equal(rpcRequest.method, "getGenesisHash");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpcRequest.id, result: genesisHash }));
    });
  });
  return listen(server);
}

test("startup detection identifies mainnet from its measured genesis hash and prints a distinct banner", async () => {
  const rpc = await startGenesisHashRpc(SOLANA_GENESIS_HASHES["mainnet-beta"]);
  try {
    const detection = await detectSolanaNetwork(new Connection(rpc.endpoint));
    assert.deepEqual(detection, { genesisHash: SOLANA_GENESIS_HASHES["mainnet-beta"], detectedCluster: "mainnet-beta" });
    assert.match(networkStartupLines(detection, "mainnet-beta").join("\n"), /!!! MAINNET-BETA DETECTED/);
  } finally {
    await rpc.close();
  }
});

test("startup detection identifies devnet from its measured genesis hash", async () => {
  const rpc = await startGenesisHashRpc(SOLANA_GENESIS_HASHES.devnet);
  try {
    const detection = await detectSolanaNetwork(new Connection(rpc.endpoint));
    assert.deepEqual(detection, { genesisHash: SOLANA_GENESIS_HASHES.devnet, detectedCluster: "devnet" });
    assert.match(networkStartupLines(detection, "devnet").join("\n"), /DEVNET DETECTED/);
  } finally {
    await rpc.close();
  }
});

test("startup detection reports an unrecognized genesis hash without assigning a cluster", async () => {
  const genesisHash = "UnrecognizedGenesisHash111111111111111111111111111";
  const rpc = await startGenesisHashRpc(genesisHash);
  try {
    const detection = await detectSolanaNetwork(new Connection(rpc.endpoint));
    assert.deepEqual(detection, { genesisHash, detectedCluster: undefined });
    assert.match(networkStartupLines(detection, undefined).join("\n"), /UNKNOWN SOLANA NETWORK DETECTED/);
  } finally {
    await rpc.close();
  }
});

test("startup detection warns when configured and measured networks disagree", async () => {
  const rpc = await startGenesisHashRpc(SOLANA_GENESIS_HASHES["mainnet-beta"]);
  try {
    const detection = await detectSolanaNetwork(new Connection(rpc.endpoint));
    assert.match(networkStartupLines(detection, "devnet").join("\n"), /WARNING: SOLANA_CLUSTER is configured as devnet, but RPC genesis hash measured mainnet-beta/);
  } finally {
    await rpc.close();
  }
});
