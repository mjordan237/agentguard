import { ENGINE } from "../check/engine.js";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The page at /: what the sandbox is, how to call it, how to verify a result, and a small playground. `origin`
 * comes from the request's Host header, which the visitor controls, so every value is escaped before it is written.
 */
export function docsPage(options: { origin: string; repositoryUrl: string; sourceCommit?: string }): string {
  const origin = escapeHtml(options.origin), repository = escapeHtml(options.repositoryUrl);
  const commit = options.sourceCommit ? escapeHtml(options.sourceCommit) : undefined;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentGuard sandbox API</title>
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
<h1>AgentGuard sandbox API</h1>
<p class="muted">${ENGINE.name} ${ENGINE.version}. Check a Solana or EVM transaction against a policy before anything is signed.
This is a preview: it signs nothing and does not store what you send. It does not rehearse swaps, keep a running
spending total or open reviews.</p>

<h2>Call it</h2>
<pre>curl -s ${origin}/v1/check -H 'content-type: application/json' -d '{
  "chain": "solana",
  "transactionBase64": "&lt;serialized transaction&gt;",
  "policy": { "policyId": "p", "programAllowlist": ["11111111111111111111111111111111"],
              "destinationAllowlist": ["&lt;vendor&gt;"],
              "maxAmountPerTransaction": { "native": "1000000000" }, "maxAmountPerDay": { "native": "5000000000" } }
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
<p>${commit ? `This server runs commit <code>${commit}</code>.` : "This deployment does not report its commit; ask its operator which one it runs."} If the result hashes match, this API gave exactly the answer the published code gives. For a transaction that uses lookup tables,
save the response's <code>lookupTables</code> to <code>tables.json</code> first.</p>

<h2>Try it</h2>
<div id="examples"></div>
<textarea id="request" spellcheck="false"></textarea>
<p><button class="primary" id="send">Send to /v1/check</button><span id="expect" class="muted"></span></p>
<pre id="response">The response appears here.</pre>
<script>
  const request = document.getElementById("request"), response = document.getElementById("response"), expect = document.getElementById("expect");
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
      const r = await fetch("/v1/check", { method: "POST", headers: { "content-type": "application/json" }, body: request.value });
      response.textContent = r.status + "\\n" + JSON.stringify(await r.json(), null, 2);
    } catch (error) { response.textContent = String(error); }
  };
</script>
</body></html>`;
}
