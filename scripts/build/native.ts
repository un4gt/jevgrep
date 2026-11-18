import { run } from "../common";
// Build inputs are file paths. The credential and secret bytes never enter the JS loader.
await run([process.platform === "win32" ? "python" : "python3", "scripts/build/native.py", ...process.argv.slice(2)]);
