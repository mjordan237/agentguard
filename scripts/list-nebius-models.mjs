// Lists Nemotron model ids served by Nebius Token Factory.
// Usage: NEBIUS_API_KEY=... node scripts/list-nebius-models.mjs
const key = process.env.NEBIUS_API_KEY;
if (!key) {
  console.error("Set NEBIUS_API_KEY first.");
  process.exit(1);
}
const base = (process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1").replace(/\/+$/, "");
const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
if (!response.ok) {
  console.error(`GET ${base}/models responded ${response.status}`);
  process.exit(1);
}
const { data = [] } = await response.json();
const ids = data.map((model) => model.id).filter((id) => /nemotron/i.test(id));
console.log(ids.length ? ids.join("\n") : `No Nemotron models found among ${data.length} models.`);
