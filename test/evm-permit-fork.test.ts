import test from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { decodeEvmTypedData, evaluateEvmTypedData, PERMIT2, type TypedDataRequest } from "../src/evm/typed-data.js";
import { parsePolicy } from "../src/policy/validate.js";

// Runs only with EVM_FORK_RPC set to an anvil node forked from Ethereum mainnet (see README "EVM fork test").
// Signs real EIP-712 permits and submits them to the real USDC and Permit2 contracts, then checks that the
// allowance the contract recorded is the one the decoder said was being granted.
const RPC = process.env.EVM_FORK_RPC;
const skip = RPC ? false : "set EVM_FORK_RPC to an anvil mainnet fork to run";

const SUBMITTER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // anvil account 0 pays gas
const VENDOR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
// Throwaway key derived from a phrase. Obvious keys (0x4242..., anvil's defaults) are EIP-7702-delegated on mainnet,
// which makes USDC validate through ERC-1271 and reject a plain ECDSA permit.
const KEY = keccak_256(new TextEncoder().encode("agentguard evm permit fork test key"));

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const k = (b: Uint8Array | string) => keccak_256(typeof b === "string" ? enc.encode(b) : b);
const sel = (s: string) => hex(k(s)).slice(0, 8);
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const OWNER = `0x${hex(k(secp256k1.getPublicKey(KEY, false).slice(1))).slice(24)}`;

type Types = Record<string, { name: string; type: string }[]>;
function encodeType(name: string, types: Types): string {
  const deps = new Set<string>();
  const walk = (n: string) => types[n].forEach((f) => { const base = f.type.replace("[]", ""); if (types[base] && !deps.has(base) && base !== name) { deps.add(base); walk(base); } });
  walk(name);
  return [name, ...[...deps].sort()].map((n) => `${n}(${types[n].map((f) => `${f.type} ${f.name}`).join(",")})`).join("");
}
function encodeValue(type: string, value: any, types: Types): string {
  if (type.endsWith("[]")) return hex(k(Buffer.from((value as any[]).map((v) => encodeValue(type.slice(0, -2), v, types)).join(""), "hex")));
  if (types[type]) return hashStruct(type, value, types);
  if (type === "address") return addrWord(value);
  if (type === "bool") return word(value ? 1n : 0n);
  if (type === "string") return hex(k(value));
  if (type === "bytes32") return (value as string).slice(2);
  if (type.startsWith("uint")) return word(BigInt(value));
  throw new Error(`unsupported type ${type}`);
}
function hashStruct(name: string, value: any, types: Types): string {
  return hex(k(Buffer.from(hex(k(encodeType(name, types))) + types[name].map((f) => encodeValue(f.type, value[f.name], types)).join(""), "hex")));
}
function domainTypes(domain: Record<string, unknown>) {
  const fields = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"]].filter(([n]) => domain[n] !== undefined);
  return fields.map(([name, type]) => ({ name, type }));
}
function sign(request: TypedDataRequest): { r: string; s: string; v: number; signature: string } {
  const { domain, types, primaryType, message } = request.typedData;
  const withDomain: Types = { ...types, EIP712Domain: domainTypes(domain) };
  const digest = k(Buffer.from("1901" + hashStruct("EIP712Domain", domain, withDomain) + hashStruct(primaryType, message, withDomain), "hex"));
  const sig = secp256k1.sign(digest, KEY);
  const r = word(sig.r), s = word(sig.s), v = 27 + sig.recovery;
  return { r, s, v, signature: `${r}${s}${v.toString(16)}` };
}

let id = 0;
async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(RPC!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = (await res.json()) as any;
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const callWord = async (to: string, data: string) => (await rpc("eth_call", [{ to, data }, "latest"])) as string;
async function submit(to: string, data: string): Promise<boolean> {
  const hash = await rpc("eth_sendTransaction", [{ from: SUBMITTER, to, data, gas: "0x200000" }]);
  let receipt = null;
  for (let i = 0; i < 50 && !receipt; i++) { receipt = await rpc("eth_getTransactionReceipt", [hash]); if (!receipt) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(receipt, "no receipt");
  return receipt.status === "0x1";
}

const PERMIT_TYPES: Types = { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
const usdcNonce = async () => BigInt(await callWord(USDC, `0x${sel("nonces(address)")}${addrWord(OWNER)}`));
const usdcPermit = (value: bigint, nonce = 0n, types: Types = PERMIT_TYPES): TypedDataRequest => ({
  from: OWNER,
  typedData: { domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC }, primaryType: "Permit", types,
    message: { owner: OWNER, spender: VENDOR, value: value.toString(), nonce: nonce.toString(), deadline: "9999999999" } }
});
const permitCall = (value: bigint, s: ReturnType<typeof sign>) =>
  `0x${sel("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)")}${addrWord(OWNER)}${addrWord(VENDOR)}${word(value)}${word(9999999999n)}${word(BigInt(s.v))}${s.r}${s.s}`;

test("fork: the test signer is a plain account with no code", { skip }, async () => {
  assert.equal(await rpc("eth_getCode", [OWNER, "latest"]), "0x");
});

test("fork: the test's EIP-712 domain separator equals the one the USDC contract reports", { skip }, async () => {
  const domain = { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC };
  const mine = hashStruct("EIP712Domain", domain, { EIP712Domain: domainTypes(domain) });
  const onchain = (await callWord(USDC, `0x${sel("DOMAIN_SEPARATOR()")}`)).slice(2);
  assert.equal(mine, onchain);
});

test("fork: a signed USDC permit sets exactly the allowance the decoder reported", { skip }, async () => {
  const request = usdcPermit(777_000_000n, await usdcNonce());
  const d = decodeEvmTypedData(request).instructions[0];
  assert.equal(d.mode, "interpolated");
  const call = permitCall(777_000_000n, sign(request));
  try { await rpc("eth_call", [{ from: SUBMITTER, to: USDC, data: call }, "latest"]); } catch (e) { assert.fail(`USDC rejected the permit: ${(e as Error).message}`); }
  assert.equal(await submit(USDC, call), true, "the real USDC contract accepted the signature");
  const allowance = BigInt(await callWord(USDC, `0x${sel("allowance(address,address)")}${addrWord(OWNER)}${addrWord(VENDOR)}`));
  assert.equal(allowance, d.amount);
  assert.equal(d.destination, VENDOR);
  assert.equal(d.asset, USDC);
});

test("fork: the policy verdict on that same permit is ALLOW within limits and review beyond them", { skip }, async () => {
  const policy = parsePolicy({
    policyId: "p", programAllowlist: [USDC], destinationAllowlist: [VENDOR],
    maxAmountPerTransaction: { [USDC]: "1000000000" }, maxAmountPerDay: { [USDC]: "3000000000" }, allowedChainIds: [1],
    maxPermitLifetimeSeconds: 10_000_000_000 // the test permits use a far-future deadline so they stay valid on any fork clock
  });
  assert.equal(evaluateEvmTypedData(usdcPermit(777_000_000n), policy).decision, "ALLOW");
  assert.equal(evaluateEvmTypedData(usdcPermit(5_000_000_000n), policy).decision, "NEEDS_REVIEW");
});

test("fork: why the layout check matters: a signature over a different layout does NOT authorise what the message appears to say", { skip }, async () => {
  // Same message fields, but the declared type has an extra field: the signed digest differs, so the real
  // contract recovers a different signer and rejects it. A gate that read only `message` would have been misled.
  const odd: Types = { Permit: [...PERMIT_TYPES.Permit, { name: "memo", type: "bytes32" }] };
  const request = usdcPermit(1n, await usdcNonce(), odd);
  (request.typedData.message as any).memo = "0x" + "00".repeat(32);
  const withMemo = { ...request.typedData, types: odd };
  const sig = sign({ ...request, typedData: withMemo });
  const decoded = decodeEvmTypedData({ ...request, typedData: withMemo }).instructions[0];
  assert.equal(decoded.mode, "raw_dump", "the gate refuses to read a non-standard layout");
  assert.equal(await submit(USDC, permitCall(1n, sig)), false, "and the real contract also rejects it");
});

test("fork: a signed Permit2 PermitSingle sets exactly the allowance the decoder reported", { skip }, async () => {
  assert.notEqual(await rpc("eth_getCode", [PERMIT2, "latest"]), "0x", "Permit2 exists at the fork block");
  const details = [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }];
  const request: TypedDataRequest = {
    from: OWNER,
    typedData: {
      domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 }, primaryType: "PermitSingle",
      types: { PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }], PermitDetails: details },
      message: { details: { token: USDC, amount: "321000000", expiration: "9999999999", nonce: "0" }, spender: VENDOR, sigDeadline: "9999999999" }
    }
  };
  const before = await callWord(PERMIT2, `0x${sel("allowance(address,address,address)")}${addrWord(OWNER)}${addrWord(USDC)}${addrWord(VENDOR)}`);
  const nonce = BigInt("0x" + before.slice(2 + 128, 2 + 192));
  (request.typedData.message as any).details.nonce = nonce.toString();
  const d = decodeEvmTypedData(request).instructions[0];
  assert.equal(d.mode, "interpolated");
  const s = sign(request);
  // permit(address owner, PermitSingle permitSingle, bytes signature): the struct is static, so it sits inline; eight head words put the bytes offset at 0x100.
  const data = `0x${sel("permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)")}${addrWord(OWNER)}${addrWord(USDC)}${word(321_000_000n)}${word(9999999999n)}${word(nonce)}${addrWord(VENDOR)}${word(9999999999n)}${word(0x100n)}${word(65n)}${s.signature.padEnd(192, "0")}`;
  try { await rpc("eth_call", [{ from: SUBMITTER, to: PERMIT2, data }, "latest"]); } catch (e) { assert.fail(`Permit2 rejected the permit (nonce ${nonce}): ${(e as Error).message}`); }
  assert.equal(await submit(PERMIT2, data), true, "the real Permit2 contract accepted the signature");
  const out = await callWord(PERMIT2, `0x${sel("allowance(address,address,address)")}${addrWord(OWNER)}${addrWord(USDC)}${addrWord(VENDOR)}`);
  assert.equal(BigInt("0x" + out.slice(2, 66)), d.amount);
  assert.equal(d.destination, VENDOR);
  assert.equal(d.asset, USDC);
});
