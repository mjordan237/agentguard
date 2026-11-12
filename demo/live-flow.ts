/**
 * Starts the demo server (see demo-server.ts) for a recorded walkthrough, prints one JSON line with the URLs
 * and credentials, then keeps serving until killed. Used by demo/video-render/capture.mjs.
 * Usage: node dist/demo/live-flow.js [port]
 */
import { startDemoServer } from "./demo-server.js";

const demo = await startDemoServer(Number(process.argv[2] ?? 4777));
console.log(JSON.stringify(demo.info));
