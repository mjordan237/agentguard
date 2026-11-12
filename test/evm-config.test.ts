import test from "node:test";
import assert from "node:assert/strict";
import { evmConfigFromEnv } from "../src/evm/config.js";

const KEY = "11".repeat(32);

test("evm config: with nothing set everything is off and the notes say so", () => {
  const c = evmConfigFromEnv({}, false);
  assert.equal(c.evmSigner, undefined);
  assert.equal(c.evmCodeLookup, undefined);
  assert.equal(c.evmBroadcaster, undefined);
  assert.match(c.notes.join("\n"), /code checks .* are off/);
  assert.match(c.notes.join("\n"), /No EVM signer configured/);
});

test("evm config: RPC URLs turn on the code check, and broadcast needs its own switch", () => {
  const urls = JSON.stringify({ 1: "https://rpc.example", 8453: "http://localhost:8545" });
  const c = evmConfigFromEnv({ EVM_RPC_URLS: urls }, true);
  assert.equal(typeof c.evmCodeLookup, "function");
  assert.equal(c.evmBroadcaster, undefined, "reading the chain does not mean sending to it");
  assert.equal(typeof evmConfigFromEnv({ EVM_RPC_URLS: urls, EVM_BROADCAST: "true" }, true).evmBroadcaster, "function");
  assert.throws(() => evmConfigFromEnv({ EVM_BROADCAST: "true" }, false), /needs EVM_RPC_URLS/);
});

test("evm config: bad RPC settings are errors, not silently ignored", () => {
  for (const bad of ["not json", "[]", "{}", "null", '{"x":"https://a"}', '{"1":"ftp://a"}', '{"1":5}', '{"0":"https://a"}']) {
    assert.throws(() => evmConfigFromEnv({ EVM_RPC_URLS: bad }, false), /EVM_RPC_URLS/, bad);
  }
  assert.throws(() => evmConfigFromEnv({ EVM_BROADCAST: "yes", EVM_RPC_URLS: '{"1":"https://a"}' }, false), /exactly true or false/);
});

test("evm config: a local key needs the explicit allow flag, is refused in production, and is never printed", () => {
  assert.throws(() => evmConfigFromEnv({ EVM_LOCAL_KEY_HEX: KEY }, false), /EVM_ALLOW_LOCAL_KEY=true/);
  assert.throws(() => evmConfigFromEnv({ EVM_LOCAL_KEY_HEX: KEY, EVM_ALLOW_LOCAL_KEY: "true" }, true), /refused when AGENTGUARD_PRODUCTION=true/);
  assert.throws(() => evmConfigFromEnv({ EVM_LOCAL_KEY_HEX: "abc", EVM_ALLOW_LOCAL_KEY: "true" }, false), /32 bytes/);
  const c = evmConfigFromEnv({ EVM_LOCAL_KEY_HEX: `0x${KEY}`, EVM_ALLOW_LOCAL_KEY: "true" }, false);
  assert.match(c.evmSigner!.address, /^0x[0-9a-f]{40}$/);
  assert.ok(!c.notes.join("\n").includes(KEY), "key material must not appear in startup output");
  assert.match(c.notes.join("\n"), new RegExp(c.evmSigner!.address));
});
