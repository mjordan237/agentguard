/**
 * Starts the demo server (see demo-server.ts) for local integration tooling, prints one JSON line with the URLs
 * and credentials, then keeps serving until killed. The generated credentials are for this temporary local instance.
 * Usage: node dist/demo/live-flow.js [port]
 */
import { startDemoServer } from "./demo-server.js";

const demo = await startDemoServer(Number(process.argv[2] ?? 4777));
console.log(JSON.stringify(demo.info));
