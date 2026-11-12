import express, { type Response } from "express";
import type { LookupTableResolver } from "../agent-integration/parse-transaction.js";
import { clientKey, RateLimiter } from "../api/rate-limiter.js";
import { CheckInputError, ENGINE, policyNotes, runCheck } from "../check/engine.js";
import { checkPolicy } from "../policy/validate.js";
import { sandboxExamples } from "./examples.js";
import { openApiDocument } from "./openapi.js";
import { docsPage } from "./docs-page.js";

/**
 * The public sandbox: anyone can check a transaction against a policy they send, and get the same answer, and
 * the same receipt, as `npm run check` gives locally. It is a separate server from the gate on purpose. It holds
 * no keys, cannot sign, keeps nothing, opens no reviews and sends nothing to Slack; the worst a caller can do is
 * use its CPU and, when an RPC is configured, ask it to read a few lookup tables.
 */
export interface SandboxConfig {
  /** Reads lookup tables a request does not supply. Without it, such transactions are held. */
  resolveLookupTable?: LookupTableResolver;
  rateLimit?: { maxRequests: number; windowMs: number };
  trustProxy?: number;
  /** The git commit this build came from, so a developer can check out exactly that code to verify a receipt. */
  sourceCommit?: string;
  /** Where the published code lives, shown on the docs page for verifying a receipt. */
  repositoryUrl?: string;
}

const BODY_LIMIT = "64kb";

export function createSandboxServer(config: SandboxConfig = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy !== undefined) app.set("trust proxy", config.trustProxy);

  // Readable from any web page: there are no cookies or credentials to protect, and that is what a playground needs.
  app.use((req, res, next) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "X-Content-Type-Options": "nosniff" });
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  });

  const limiter = new RateLimiter(config.rateLimit?.maxRequests ?? 60, config.rateLimit?.windowMs ?? 60_000);
  const limited = (req: express.Request, res: Response, next: express.NextFunction) => {
    if (!limiter.allow(`sandbox:${clientKey(req.ip)}`)) return void res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests; try again in a minute." });
    next();
  };
  const json = (res: Response, status: number, body: unknown) =>
    res.status(status).type("application/json").send(JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  const safe = (handler: (req: express.Request, res: Response) => Promise<unknown>) =>
    (req: express.Request, res: Response, next: express.NextFunction) => { handler(req, res).catch(next); };

  app.use(express.json({ limit: BODY_LIMIT }));

  app.get("/", (req, res) => {
    res.type("html").send(docsPage({ origin: `${req.protocol}://${req.get("host") ?? "localhost"}`, repositoryUrl: config.repositoryUrl ?? "https://github.com/mjordan237/agentguard", sourceCommit: config.sourceCommit }));
  });
  app.get("/favicon.ico", (_req, res) => { res.status(204).end(); });
  app.get("/healthz", (_req, res) => json(res, 200, { ok: true }));
  app.get("/openapi.json", (_req, res) => json(res, 200, openApiDocument()));
  app.get("/v1", (_req, res) => json(res, 200, {
    engine: ENGINE,
    sourceCommit: config.sourceCommit ?? "not reported by this deployment",
    signs: false,
    stores: false,
    lookupTables: config.resolveLookupTable ? "read from the configured RPC when not supplied" : "only those supplied in the request",
    limits: { bodyBytes: BODY_LIMIT, requestsPerMinute: config.rateLimit?.maxRequests ?? 60 },
    verify: "Check out sourceCommit, then run `npm run check -- --json` on the same input: its receipt must equal this API's."
  }));
  app.get("/v1/examples", limited, (_req, res) => json(res, 200, sandboxExamples()));

  app.post("/v1/policies/validate", limited, (req, res) => {
    const checked = checkPolicy(req.body?.policy);
    if (!checked.policy) return json(res, 200, { valid: false, problems: checked.problems, notes: [] });
    return json(res, 200, { valid: true, problems: [], notes: policyNotes(checked.policy) });
  });

  app.post("/v1/check", limited, safe(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const chain = body?.chain ?? "solana";
    if (chain !== "solana" && chain !== "evm") return json(res, 400, { error: "INVALID_REQUEST", message: 'chain must be "solana" or "evm".' });
    if (body?.spentToday !== undefined && (typeof body.spentToday !== "object" || body.spentToday === null || Array.isArray(body.spentToday))) {
      return json(res, 400, { error: "INVALID_REQUEST", message: "spentToday must be an object of asset to amount strings." });
    }
    if (body?.lookupTables !== undefined && (typeof body.lookupTables !== "object" || body.lookupTables === null || Array.isArray(body.lookupTables))) {
      return json(res, 400, { error: "INVALID_REQUEST", message: "lookupTables must be an object of table address to address lists." });
    }
    try {
      const result = chain === "evm"
        ? await runCheck({ chain, transaction: body?.transaction, policy: body?.policy, spentToday: body?.spentToday as Record<string, string> | undefined })
        : await runCheck({ chain, transactionBase64: body?.transactionBase64 as string, policy: body?.policy, spentToday: body?.spentToday as Record<string, string> | undefined, lookupTables: body?.lookupTables as Record<string, string[]> | undefined }, config.resolveLookupTable);
      return json(res, 200, result);
    } catch (error) {
      if (error instanceof CheckInputError) return json(res, 400, { error: "INVALID_REQUEST", message: error.message, problems: error.problems });
      throw error;
    }
  }));

  app.use((_req, res) => json(res, 404, { error: "NOT_FOUND", message: "See GET /openapi.json for the endpoints." }));
  app.use((error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
    const status = (error as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return json(res, status, { error: status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST", message: status === 413 ? `The request body is over ${BODY_LIMIT}.` : "The request body is not valid JSON." });
    }
    console.error("Sandbox request failed:", error);
    return json(res, 500, { error: "INTERNAL_ERROR", message: "The check failed." });
  });

  return app;
}
