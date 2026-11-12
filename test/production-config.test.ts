import test from "node:test";
import assert from "node:assert/strict";
import { productionConfigProblems, reviewSecretProblem } from "../src/api/production-config.js";

const complete = {
  REQUIRE_API_KEYS: "true",
  REVIEW_REQUIRE_REVIEWERS: "true",
  AGENTGUARD_DB_PATH: "/data/agentguard.sqlite",
  BASE_URL: "https://guard.example.com",
  TRUST_PROXY: "1"
};

test("a complete production environment has no problems", () => {
  assert.deepEqual(productionConfigProblems(complete), []);
});

test("TRUST_PROXY=0 is an explicit answer and is accepted", () => {
  assert.deepEqual(productionConfigProblems({ ...complete, TRUST_PROXY: "0" }), []);
});

test("production refuses a missing, plain-http or localhost BASE_URL", () => {
  for (const BASE_URL of [undefined, "http://guard.example.com", "https://localhost:8787", "not a url"]) {
    const problems = productionConfigProblems({ ...complete, BASE_URL });
    assert.equal(problems.length, 1, `BASE_URL=${BASE_URL}`);
    assert.match(problems[0], /BASE_URL/);
  }
});

test("production refuses an unset TRUST_PROXY", () => {
  const problems = productionConfigProblems({ ...complete, TRUST_PROXY: undefined });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TRUST_PROXY/);
});

test("the existing production controls are still required", () => {
  const problems = productionConfigProblems({ BASE_URL: complete.BASE_URL, TRUST_PROXY: "1" });
  assert.equal(problems.length, 3);
});

test("a short review secret is refused, a long one and none are accepted", () => {
  assert.match(reviewSecretProblem("review-secret") ?? "", /at least 32/);
  assert.equal(reviewSecretProblem("a".repeat(32)), undefined);
  assert.equal(reviewSecretProblem(undefined), undefined);
});
