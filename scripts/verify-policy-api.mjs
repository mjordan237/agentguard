// Synthetic policy checks only. Does not call signing routes or submit chain transactions.
const base = new URL(process.env.AGENTGUARD_API_URL ?? "http://127.0.0.1:8788");
const key = process.env.AGENTGUARD_API_KEY;
if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("AGENTGUARD_API_URL must be an origin without credentials, path, query or fragment.");
if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("Use HTTPS, except for local loopback tests.");
if (!key) throw new Error("AGENTGUARD_API_KEY is required; provide it through the environment.");

async function request(route, body, authenticated = false) {
  const response = await fetch(new URL(route, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    redirect: "error"
  });
  return { status: response.status, body: await response.json() };
}
function expect(condition, message) { if (!condition) throw new Error(message); }

try {
  expect((await request("/healthz")).status === 200, "Health check failed.");
  const discovery = await request("/v1");
  expect(discovery.status === 200 && discovery.body.authentication === "bearer" && discovery.body.signs === false, "Not the authenticated policy API.");
  if (process.env.AGENTGUARD_EXPECT_COMMIT) expect(discovery.body.sourceCommit === process.env.AGENTGUARD_EXPECT_COMMIT, "Reported source commit does not match the expected release.");
  const spec = await request("/openapi.json");
  for (const route of ["/v1/check", "/v1/policies/validate"]) {
    expect(spec.body.paths?.[route]?.post?.security?.some(rule => "bearerAuth" in rule), "OpenAPI is missing bearer authentication.");
    expect((await request(route, {})).status === 401, `Unauthenticated request was not refused: ${route}`);
  }
  const examples = await request("/v1/examples");
  expect(examples.status === 200 && examples.body.examples?.length >= 6, "Example discovery failed.");
  const checked = [];
  for (const example of examples.body.examples) {
    const validation = await request("/v1/policies/validate", { policy: example.body.policy }, true);
    expect(validation.status === 200 && validation.body.valid === true, `Example policy failed validation: ${example.name}`);
    const result = await request("/v1/check", example.body, true);
    expect(result.status === 200 && result.body.decision === example.expect, `Unexpected decision for ${example.name}; HTTP ${result.status}.`);
    expect(/^[a-f0-9]{64}$/.test(result.body.receipt?.inputHash) && /^[a-f0-9]{64}$/.test(result.body.receipt?.resultHash), `Missing receipt for ${example.name}.`);
    checked.push({ name: example.name, decision: result.body.decision });
  }
  console.log(JSON.stringify({ ok: true, origin: base.origin, sourceCommit: discovery.body.sourceCommit, checked, signs: false }, null, 2));
} catch (error) {
  // Never print request headers, credentials or arbitrary upstream response bodies.
  console.error(error instanceof TypeError ? "Verification request failed; check the endpoint and connectivity." : error.message);
  process.exitCode = 1;
}
