import { resolve } from "node:path";
export const root = resolve(import.meta.dir, "..");
export const upstream = resolve(root, ".work/upstream");
export async function run(args: string[], cwd = root, env: Record<string, string> = {}, timeout = 20 * 60_000) {
  console.log(`> ${args.join(" ")}`);
  const child = Bun.spawn(args, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit", timeout });
  if (await child.exited !== 0) throw new Error(`Command failed: ${args[0]} ${args[1] ?? ""}`);
}
export async function output(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "inherit" });
  const result = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`Command failed: ${args[0]}`);
  return result.trim();
}
export const lock = () => Bun.file(resolve(root, "upstream.lock")).json();
