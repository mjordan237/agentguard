import test from "node:test";
import assert from "node:assert/strict";
import { LocalKeySigner, rlp } from "../src/evm/sign.js";

// Reference values produced by foundry's `cast mktx` (forge 1.7.1) with the same key and parameters:
//   cast mktx <to> ... --private-key $KEY --chain 1 --nonce N --gas-limit G --gas-price 30000000000 --priority-gas-price 2000000000
const KEY = Uint8Array.from(Buffer.from("3342460a1ac7dc070dfa35508ff134dfa8664edd4ce80e7f112e43cc118ba87e", "hex"));
const ADDRESS = "0x44276f7e82d7e1081da9ad93254dca6943a5d5a7";
const signer = new LocalKeySigner(KEY);
const fees = { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };

test("evm sign: the signer derives the same address as foundry", () => {
  assert.equal(signer.address, ADDRESS);
});

test("evm sign: a native transfer signs to exactly the bytes cast mktx produced", async () => {
  const raw = await signer.signTransaction({ chainId: 1, from: ADDRESS, to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", value: 123456789n, nonce: 7n, gasLimit: 21000n, ...fees });
  assert.equal(raw, "0x02f86f010784773594008506fc23ac008252089470997970c51812dc3a010c7d01b50e0d17dc79c884075bcd1580c001a02638282d68115fa4604b721488ab476410b57bb188464310ebf59b02a4c1f4e0a065c69e42fb376d80083b0e74730390165073edc5382595ba1d19a54b8cfb4347");
});

test("evm sign: an ERC-20 transfer signs to exactly the bytes cast mktx produced", async () => {
  const data = "0xa9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000f4240";
  const raw = await signer.signTransaction({ chainId: 1, from: ADDRESS, to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", data, nonce: 8n, gasLimit: 65000n, ...fees });
  assert.equal(raw, "0x02f8b0010884773594008506fc23ac0082fde894a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4880b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000f4240c001a0e4df1145dafc0e6e25040257048cc9b2c2dd23d1128d0566d7b93567ffbc874ea05c0b5da5d450873a2d2dec5739a4220e49e88b19b7081128fa4fba2c89d7be9c");
});

test("evm sign: it refuses to sign for another address", async () => {
  await assert.rejects(signer.signTransaction({ chainId: 1, from: "0x1111111111111111111111111111111111111111", to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", nonce: 0n, gasLimit: 21000n, ...fees }), /controls/);
});

test("evm sign: malformed recipients and calldata are refused, not signed", async () => {
  const base = { chainId: 1, from: ADDRESS, nonce: 0n, gasLimit: 21000n, ...fees };
  await assert.rejects(signer.signTransaction({ ...base, to: "0x1234" }), /recipient/);
  await assert.rejects(signer.signTransaction({ ...base, to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", data: "0xzz" }), /calldata/);
});

test("evm sign: RLP matches the specification's examples", () => {
  const h = (b: Uint8Array) => Buffer.from(b).toString("hex");
  assert.equal(h(rlp(new TextEncoder().encode("dog"))), "83646f67");
  assert.equal(h(rlp([new TextEncoder().encode("cat"), new TextEncoder().encode("dog")])), "c88363617483646f67");
  assert.equal(h(rlp(new Uint8Array(0))), "80");
  assert.equal(h(rlp([])), "c0");
  assert.equal(h(rlp(Uint8Array.of(0x0f))), "0f");
  assert.equal(h(rlp(Uint8Array.of(0x04, 0x00))), "820400");
  assert.equal(h(rlp(new Uint8Array(56).fill(0x61))).slice(0, 4), "b838");
});
