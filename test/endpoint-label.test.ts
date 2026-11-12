import test from "node:test";
import assert from "node:assert/strict";
import { endpointLabel } from "../src/network/endpoint-label.js";

test("endpoint labels omit credentials in user-info, path, query and fragment", () => {
  assert.equal(endpointLabel("https://user:synthetic@example.test:8443/private-key?apiKey=synthetic#secret"), "https://example.test:8443");
  assert.equal(endpointLabel("http://127.0.0.1:8899"), "http://127.0.0.1:8899");
  assert.equal(endpointLabel("invalid synthetic credential"), "[invalid endpoint]");
});
