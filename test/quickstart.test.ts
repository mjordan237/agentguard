import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../demo/quickstart.js");
const run = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ...env } });

test("quickstart: the whole first-run story works, in one process, and exits cleanly", () => {
  const started = Date.now();
  const r = run({ PORT: "0" }, "--auto-approve", "--exit");
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /ALLOWED and signed/);
  assert.match(out, /HELD for a person/);
  assert.match(out, /stranger: NEEDS_REVIEW .*not in the allowlist/);
  assert.match(out, /over the limit: NEEDS_REVIEW .*exceeds the per-transaction limit/);
  assert.match(out, /approved by the demo reviewer \(HTTP 302\)/);
  assert.match(out, /the agent retries and is signed: stand-in-relayer-signature-2/);
  assert.match(out, /the same approval used again is refused/);
  assert.doesNotMatch(r.stderr.replace(/.*ExperimentalWarning.*\n|.*trace-warnings.*\n/g, ""), /\S/, "no unexpected stderr");
  assert.ok(Date.now() - started < 60_000, "first run finishes in under a minute");
});

test("quickstart: a busy port and a bad PORT give a plain message, not a stack trace", async () => {
  const busy = http.createServer();
  await new Promise<void>((resolve) => busy.listen(0, () => resolve()));
  const port = (busy.address() as { port: number }).port;
  try {
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, "--exit"], { env: { ...process.env, PORT: String(port) } });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (status) => resolve({ status, stderr }));
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`^Port ${port} is already in use\\. Pick another one, for example: PORT=\\d+ npm run quickstart`, "m"));
    assert.doesNotMatch(r.stderr, /EADDRINUSE/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  } finally { await new Promise<void>((resolve) => busy.close(() => resolve())); }

  for (const bad of ["abc", "-1", "70000", "1.5"]) {
    const r = run({ PORT: bad }, "--exit");
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /PORT must be a whole number/);
  }
});
