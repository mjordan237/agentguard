import { createHash } from "node:crypto";
import { canonicalJson } from "../check/canonical-json.js";
import type { Policy } from "./types.js";

/**
 * SHA-256 of a validated policy in canonical JSON: one revision of the rules. Every field is included, so any
 * change to the policy gives a new fingerprint. Key order does not matter; array order does, so reordering an
 * allowlist also counts as a new revision (an approval is then asked for again, never wrongly kept).
 */
export function policyFingerprint(policy: Policy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}
