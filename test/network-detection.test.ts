import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { Connection } from "@solana/web3.js";
import { assertConfiguredNetwork, detectSolanaNetwork, networkStartupLines, SOLANA_GENESIS_HASHES } from "../src/network/cluster-detection.js";

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

function runServerProcess(environment: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/index.js"], { cwd: process.cwd(), env: environment });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
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

test("strict startup validation rejects a configured network that disagrees with measured RPC identity", () => {
  const detection = { genesisHash: SOLANA_GENESIS_HASHES.devnet, detectedCluster: "devnet" as const };
  assert.throws(
    () => assertConfiguredNetwork(detection, "mainnet-beta"),
    /SOLANA_CLUSTER is configured as mainnet-beta, but RPC genesis hash .* identifies devnet/
  );
});

test("strict startup validation allows a matching configured network", () => {
  const detection = { genesisHash: SOLANA_GENESIS_HASHES["mainnet-beta"], detectedCluster: "mainnet-beta" as const };
  assert.doesNotThrow(() => assertConfiguredNetwork(detection, "mainnet-beta"));
});

test("mainnet configuration refuses to start when RPC identifies devnet", async () => {
  const rpc = await startGenesisHashRpc(SOLANA_GENESIS_HASHES.devnet);
  try {
    const result = await runServerProcess({
      ...process.env,
      RPC_URL: rpc.endpoint,
      SOLANA_CLUSTER: "mainnet-beta",
      PORT: "0"
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /Startup refused because strict RPC network matching is enabled/);
    assert.doesNotMatch(result.output, /AgentGuard listening/);
  } finally {
    await rpc.close();
  }
});
