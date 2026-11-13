import { ENGINE } from "../check/engine.js";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The page at /: what the sandbox is, how to call it, how to verify a result, and a small playground. `origin`
 * comes from the request's Host header, which the visitor controls, so every value is escaped before it is written.
 */
export function docsPage(options: { origin: string; repositoryUrl: string; sourceCommit?: string; requireApiKeys?: boolean }): string {
  const origin = escapeHtml(options.origin), repository = escapeHtml(options.repositoryUrl);
  const commit = options.sourceCommit ? escapeHtml(options.sourceCommit) : undefined;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentGuard policy API</title>
<style>
  body { font: 15px/1.55 system-ui, sans-serif; color: #18181b; max-width: 920px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 26px; margin-bottom: 4px; } h2 { font-size: 17px; margin-top: 32px; }
  code, pre, textarea { font: 13px/1.5 ui-monospace, monospace; }
  pre { background: #f4f4f5; padding: 12px; border-radius: 8px; overflow-x: auto; }
  textarea { width: 100%; height: 260px; box-sizing: border-box; border: 1px solid #d4d4d8; border-radius: 8px; padding: 10px; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #d4d4d8; background: #fff; cursor: pointer; margin: 0 6px 6px 0; }
  button.primary { background: #5b5bf6; color: #fff; border-color: #5b5bf6; }
  .muted { color: #52525b; }
</style></head><body>
<h1>AgentGuard policy API</h1>
<p class="muted">${ENGINE.name} ${ENGINE.version}. Evaluate a Solana or EVM transaction against a supplied policy.
This is a preview: it signs nothing and does not store what you send. It does not rehearse swaps, keep a running
spending total or open reviews.</p>
<p>${options.requireApiKeys ? "Policy-check and validation requests require a customer API key in the Authorization: Bearer header. Ask the service operator to provision a key. Keep application keys on your backend." : "Local demo mode: policy checks do not require a key. Do not expose this mode as a production service."}</p>

<h2>Call it</h2>
<pre>curl -s ${origin}/v1/check -H 'content-type: application/json'${options.requireApiKeys ? " -H 'Authorization: Bearer &lt;API_KEY&gt;'" : ""} -d '{
  "chain": "evm",
  "transaction": { "chainId": 1, "from": "0x1111111111111111111111111111111111111111",
    "to": "0x2222222222222222222222222222222222222222", "value": "1000000000000000000" },
  "policy": { "policyId": "example", "programAllowlist": ["evm:native"], "allowedChainIds": [1],
    "destinationAllowlist": ["0x2222222222222222222222222222222222222222"],
    "maxAmountPerTransaction": { "native": "2000000000000000000" }, "maxAmountPerDay": { "native": "5000000000000000000" } }
}'</pre>
<p>The answer has the decision, every reason, each instruction as it was read, and a receipt. Endpoints:
<code>POST /v1/check</code>, <code>POST /v1/policies/validate</code>, <code>GET /v1/examples</code>, and the full description at
<a href="/openapi.json">/openapi.json</a>.</p>

<h2>Verify a result yourself</h2>
<p>Every result carries <code>receipt.inputHash</code> and <code>receipt.resultHash</code>, SHA-256 over canonical JSON. Run the same
input through the open-source code and compare:</p>
<pre>git clone ${repository} agentguard &amp;&amp; cd agentguard
git checkout ${commit ?? "&lt;sourceCommit from GET /v1&gt;"}
npm ci &amp;&amp; npm run build
npm run check -- --json --policy policy.json --tx-file tx.b64 [--spent native=4800000000] [--lookup-tables tables.json]</pre>
<p>${commit ? `The operator reports commit <code>${commit}</code>.` : "This deployment does not report its commit; ask its operator which one it runs."} Matching hashes show agreement for this input, not proof of the running software or deployment configuration. For a transaction that uses lookup tables,
save the response's <code>lookupTables</code> to <code>tables.json</code> first.</p>

<h2>Try it</h2>
${options.requireApiKeys ? '<p><label for="api-key">Temporary API key for this session</label><br><input id="api-key" type="password" autocomplete="off" spellcheck="false"><button id="clear-key">Clear key</button></p><p class="muted">The key is sent only to this service in a request header. This page does not save it to browser storage.</p>' : ""}
<div id="examples"></div>
<textarea id="request" spellcheck="false"></textarea>
<p><button class="primary" id="send">Send to /v1/check</button><span id="expect" class="muted"></span></p>
<pre id="response">The response appears here.</pre>
<script>
  const request = document.getElementById("request"), response = document.getElementById("response"), expect = document.getElementById("expect");
  const apiKey = document.getElementById("api-key"), clearKey = document.getElementById("clear-key");
  if (clearKey) clearKey.onclick = () => { apiKey.value = ""; };
  fetch("/v1/examples").then((r) => r.json()).then(({ examples }) => {
    for (const example of examples) {
      const button = document.createElement("button");
      button.textContent = example.name;
      button.onclick = () => { request.value = JSON.stringify(example.body, null, 2); expect.textContent = " Expected: " + example.expect + ". " + example.about; };
      document.getElementById("examples").appendChild(button);
    }
    if (examples[0]) document.querySelector("#examples button").click();
  });
  document.getElementById("send").onclick = async () => {
    response.textContent = "Checking...";
    try {
      const headers = { "content-type": "application/json" };
      if (apiKey && apiKey.value.trim()) headers.authorization = "Bearer " + apiKey.value.trim();
      const r = await fetch("/v1/check", { method: "POST", headers, body: request.value });
      response.textContent = r.status + "\\n" + JSON.stringify(await r.json(), null, 2);
    } catch (error) { response.textContent = String(error); }
  };
</script>
</body></html>`;
}
