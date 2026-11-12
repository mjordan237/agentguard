import { createECDH, createPrivateKey, sign, type KeyObject } from "node:crypto";

/** Order of the P-256 group. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** DER-encodes a signature from r and s. */
function der(r: bigint, s: bigint): Buffer {
  const integer = (value: bigint) => {
    let bytes = Buffer.from(value.toString(16).padStart(64, "0"), "hex");
    while (bytes.length > 1 && bytes[0] === 0 && bytes[1]! < 0x80) bytes = bytes.subarray(1);
    if (bytes[0]! >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([integer(r), integer(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** Node may return either of the two valid s values; strict verifiers accept only the low one, so always use it. */
function lowS(signature: Buffer): Buffer {
  const rLength = signature[3]!;
  const r = BigInt(`0x${signature.subarray(4, 4 + rLength).toString("hex")}`);
  const sLength = signature[5 + rLength]!;
  const s = BigInt(`0x${signature.subarray(6 + rLength, 6 + rLength + sLength).toString("hex")}`);
  return s > N / 2n ? der(r, N - s) : signature;
}

/**
 * Signs Turnkey API requests with a P-256 API key, as Turnkey specifies: an ECDSA (SHA-256, DER) signature over
 * the exact JSON body (low-S), hex-encoded, wrapped with the public key and scheme, base64url-encoded into `X-Stamp`.
 * https://docs.turnkey.com/developer-reference/api-overview/stamps
 */
export class ApiKeyStamper {
  private readonly key: KeyObject;
  readonly publicKey: string;

  /** Both keys as hex, the way Turnkey shows them: the private scalar, and the compressed public key. */
  constructor(apiPublicKeyHex: string, apiPrivateKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(apiPrivateKeyHex)) throw new Error("The Turnkey API private key must be 32 bytes of hex.");
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(apiPrivateKeyHex, "hex"));
    const compressed = ecdh.getPublicKey("hex", "compressed");
    // A mismatched pair would be refused by Turnkey on every call; say so at startup instead.
    if (compressed !== apiPublicKeyHex.toLowerCase()) throw new Error("The Turnkey API public key does not belong to the private key.");
    const uncompressed = ecdh.getPublicKey();
    this.key = createPrivateKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", d: Buffer.from(apiPrivateKeyHex, "hex").toString("base64url"), x: uncompressed.subarray(1, 33).toString("base64url"), y: uncompressed.subarray(33, 65).toString("base64url") }
    });
    this.publicKey = compressed;
  }

  /** The X-Stamp header value for this exact body. */
  stamp(body: string): string {
    const signature = lowS(sign("sha256", Buffer.from(body), { key: this.key, dsaEncoding: "der" })).toString("hex");
    return Buffer.from(JSON.stringify({ publicKey: this.publicKey, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature })).toString("base64url");
  }
}
