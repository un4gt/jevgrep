import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
export const cli = process.env.JG_TEST_CLI || resolve(".work/upstream/apps/cli/dist/bin/index.js");
export async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "emrank-jg-"));
  const env = { ...process.env, EMRANK_ISSUER: undefined, EMRANK_HOME: join(dir, "emrank"), XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"), EMRANK_PROVIDER: "auto", CI: "1", EMRANK_TEST_NO_BROWSER: "1" };
  const source = join(dir, "source");
  await mkdir(source);
  await Bun.write(join(source, "events.ts"), "export function recordEvent(event: string) { return event; }\n");
  return { dir, env, source, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export function spawn(args: string[], env: Record<string, string | undefined>, stdin?: string) {
  const options = args[0] === "emrank" && args[1] === "--login" && !args.includes("--model") && env.EMRANK_MODEL ? [...args, "--model", env.EMRANK_MODEL] : args;
  return Bun.spawn(["node", cli, ...options], { env, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: 30000 });
}
export async function command(args: string[], env: Record<string, string | undefined>, stdin?: string) {
  const p = spawn(args, env, stdin);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
export async function nativeCommand(mode: string, env: Record<string, string | undefined>) {
  const p = Bun.spawn(["node", resolve("tests/emrank/native-client.mjs"), mode], {
    env: { ...env, JG_TEST_CLI: cli }, stdout: "pipe", stderr: "pipe", timeout: 30000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    const safe = stderr.replace(/https?:\/\/\S+/g, "[redacted URL]").replace(/(?:access-|refresh-)[a-zA-Z0-9-]+/g, "[redacted token]");
    throw new Error(`Native fixture failed (${mode}): ${safe}`);
  }
  return { stdout, stderr, code };
}
