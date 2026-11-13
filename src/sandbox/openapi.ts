import { ENGINE } from "../check/engine.js";

const amounts = { type: "object", additionalProperties: { type: "string", pattern: "^\\d+$" }, description: "Asset to amount in base units, as decimal strings. \"native\" is SOL (lamports) or ETH (wei); tokens are keyed by mint or contract address." };

/** OpenAPI 3.1 description of the sandbox, served at /openapi.json. */
export function openApiDocument(requireApiKeys = false) {
  const security = requireApiKeys ? [{ bearerAuth: [] }] : [];
  const authResponses = {
    401: { description: "Missing, invalid or revoked customer API key" },
    429: { description: "Rate limit reached; Retry-After gives the conservative delay in seconds" }
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "AgentGuard policy API",
      version: ENGINE.version,
      description: "Evaluate a Solana or EVM transaction against a supplied policy. This preview does not sign transactions or persist requests. Results include hashes for comparison with the offline CLI using the same input."
    },
    paths: {
      "/v1": { get: { summary: "Engine version and limits", responses: { 200: { description: "Service information" } } } },
      "/v1/examples": { get: { summary: "Request bodies to try, each with the decision it should get", responses: { 200: { description: "Examples" } } } },
      "/v1/policies/validate": {
        post: {
          security,
          summary: "Validate a policy",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["policy"], properties: { policy: { $ref: "#/components/schemas/Policy" } } } } } },
          responses: { ...authResponses, 400: { description: "Malformed JSON" }, 413: { description: "Body exceeds 64 KiB" }, 200: { description: "valid, problems (one per line) and notes about settings that send everything to review" } }
        }
      },
      "/v1/check": {
        post: {
          security,
          summary: "Check one transaction against one policy",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CheckRequest" } } } },
          responses: {
            ...authResponses,
            200: { description: "The decision", content: { "application/json": { schema: { $ref: "#/components/schemas/CheckResult" } } } },
            400: { description: "The policy or transaction could not be read; `problems` lists each policy error" },
            413: { description: "The body is over 64 KB" },
            429: { description: "Rate limited" }
          }
        }
      }
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Customer API key, provisioned by the operator. Use Authorization: Bearer agk_..." } },
      schemas: {
        Policy: {
          type: "object",
          required: ["policyId", "programAllowlist", "destinationAllowlist", "maxAmountPerTransaction", "maxAmountPerDay"],
          properties: {
            policyId: { type: "string" },
            programAllowlist: { type: "array", items: { type: "string" } },
            destinationAllowlist: { type: "array", items: { type: "string" } },
            allowAnyDestination: { type: "boolean" },
            maxAmountPerTransaction: amounts,
            maxAmountPerDay: amounts,
            maxPriorityFeePerTransaction: { type: "string" },
            swapPairs: { type: "array", items: { type: "object", required: ["inputMint", "outputMint"], properties: { inputMint: { type: "string" }, outputMint: { type: "string" }, minOutPerIn: { type: "string" } } } },
            maxSlippageBps: { type: "integer" },
            maxPlatformFeeBps: { type: "integer" },
            maxPositiveSlippageBps: { type: "integer" },
            allowedChainIds: { type: "array", items: { type: "integer" } },
            maxPermitLifetimeSeconds: { type: "integer" },
            trustedDelegates: { type: "array", items: { type: "string" } }
          },
          additionalProperties: false
        },
        CheckRequest: {
          type: "object",
          required: ["policy"],
          properties: {
            chain: { enum: ["solana", "evm"], default: "solana" },
            transactionBase64: { type: "string", description: "Solana: the serialized transaction, signed or not" },
            transaction: { type: "object", description: "EVM: {chainId, from, to, value, data}, amounts as decimal strings" },
            policy: { $ref: "#/components/schemas/Policy" },
            spentToday: amounts,
            lookupTables: { type: "object", additionalProperties: { type: "array", items: { type: "string" } }, description: "Solana: address lookup tables, table address to its addresses" }
          }
        },
        CheckResult: {
          type: "object",
          properties: {
            decision: { enum: ["ALLOW", "NEEDS_REVIEW"] },
            reasons: { type: "array", items: { type: "string" } },
            decoded: { type: "object", description: "Every instruction as AgentGuard read it" },
            spend: amounts,
            policyNotes: { type: "array", items: { type: "string" } },
            lookupTables: { type: "object", description: "Tables used, so the check can be repeated offline" },
            receipt: {
              type: "object",
              properties: {
                engine: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } } },
                inputHash: { type: "string", description: "SHA-256 of the input as understood, in canonical JSON" },
                resultHash: { type: "string", description: "SHA-256 of decision, reasons, decoded and spend, in canonical JSON" }
              }
            }
          }
        }
      }
    }
  };
}
