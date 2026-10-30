import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root, upstream, run, output } from "../common";
await mkdir(resolve(root, "reports"), { recursive: true });
const evidence: { name: string; passed: boolean }[] = [];
async function check(name: string, args: string[], cwd = root, env: Record<string, string> = {}) {
  try { await run(args, cwd, { EMRANK_HOME: resolve(root, ".work/verify-signed-out"), ...env }, 5 * 60_000); evidence.push({ name, passed: true }); }
  catch (e) { evidence.push({ name, passed: false }); throw e; }
}
try {
  await check("overlay-types", ["bun", "run", "check-types"]);
  await check("rust-format", ["cargo", "fmt", "--manifest-path", "native/Cargo.toml", "--check"]);
  await check("rust-tests", ["cargo", "test", "--locked", "--manifest-path", "native/Cargo.toml"]);
  await check("upstream-types", ["bun", "run", "check-types"], upstream);
  await check("upstream-lint", ["bun", "run", "lint"], upstream);
  // The upstream package test invokes its registry installer. Our Bun tarball
  // installation suite replaces it for the separately named distribution.
  const sources = (await output(["git", "ls-files", "apps/cli/test/*.test.ts", "packages/core/test/*.test.ts"], upstream)).split("\n").filter(p => p !== "apps/cli/test/package.test.ts").map(p => `./${p}`);
  // This upstream fixture creates a newline in a filename, illegal on Windows.
  // It remains mandatory on Linux; do not patch or weaken the core implementation.
  const platformFilter = process.platform === "win32" ? ["--test-name-pattern", "^(?!inventory optionally retains eligible paths and respects exclusions and entry bounds$)"] : [];
  // Process isolation avoids global mock/timer state leaking between upstream files.
  for (const file of [...sources, "./test/discovery.test.ts", "./test/evaluator.test.ts", "./test/retrieval.test.ts", "./test/retrieval-freshness.test.ts"])
    await check(`upstream:${file}`, ["bun", "test", "--timeout", "30000", ...platformFilter, file], upstream, { JEVGREP_TEST_IN_DOCKER: "1" });
  await check("upstream-provider-protocol", ["node", "--test", "packages/core/test-node/provider-protocol.mjs"], upstream);
  await check("upstream-parsers", ["node", "--experimental-strip-types", "--test", ...((await output(["git", "ls-files", "test/parser/*.test.ts"], upstream)).split("\n"))], upstream);
  await check("overlay-cli-oauth-dpop", ["bun", "test", "--timeout", "60000", "tests"]);
  await check("pack-and-clean-install", ["bun", "run", "pack"]);
} finally {
  await Bun.write(resolve(root, "reports/verification.json"), JSON.stringify({ sha: await output(["git", "rev-parse", "HEAD"], upstream), upstream: JSON.parse(await Bun.file(resolve(root, ".work/prepared.json")).text()), platform: process.platform, node: await output(["node", "--version"]), bun: Bun.version, evidence }, null, 2) + "\n");
}
