import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
export const cli = process.env.JG_TEST_CLI || resolve(".work/upstream/apps/cli/dist/bin/index.js");
export async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "emrank-jg-"));
  const env = { ...process.env, EMRANK_HOME: join(dir, "emrank"), XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"), EMRANK_PROVIDER: "auto", CI: "1" };
  const source = join(dir, "source");
  await mkdir(source);
  await Bun.write(join(source, "events.ts"), "export function recordEvent(event: string) { return event; }\n");
  return { dir, env, source, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export function spawn(args: string[], env: Record<string, string | undefined>, stdin?: string) {
  return Bun.spawn(["node", cli, ...args], { env, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: 30000 });
}
export async function command(args: string[], env: Record<string, string | undefined>, stdin?: string) {
  const p = spawn(args, env, stdin);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
