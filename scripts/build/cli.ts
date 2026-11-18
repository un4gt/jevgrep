import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root, upstream, run } from "../common";
const args = process.argv.slice(2);
const metadata = await Bun.file(resolve(root,"native/package.json")).json();
const version = args.includes("--a") ? "0.1.0" : metadata.version;
const platform = process.platform === "win32" ? "win32-x64-msvc" : "linux-x64-gnu";
const name = `${metadata.name}-${platform}`;
if (!args.includes("--existing-native")) await run(["bun","scripts/build/native.ts",...args]);
const modules = resolve(upstream,"node_modules");
const loader = resolve(modules,metadata.name), binary = resolve(modules,name);
await mkdir(loader,{recursive:true}); await mkdir(binary,{recursive:true});
const source = resolve(process.env.EMRANK_BINARY_DIR || resolve(root,"native"),"jevgrep-native.node");
await cp(source,resolve(binary,"jevgrep-native.node"));
await Bun.write(resolve(binary,"package.json"),JSON.stringify({name,version,main:"jevgrep-native.node"}));
metadata.version = version;
for (const dep of Object.keys(metadata.optionalDependencies)) metadata.optionalDependencies[dep]=version;
await Bun.write(resolve(loader,"package.json"),JSON.stringify(metadata));
for (const file of ["index.js","index.d.ts"]) await cp(resolve(root,"native",file),resolve(loader,file));
for (const file of ["emrank.ts","emrank-login.ts"]) await cp(resolve(root,"overlay",file),resolve(upstream,"apps/cli/src",file));
// Only the isolated A build has its own release line.
const manifest = resolve(upstream,"apps/cli/package.json"), original = await readFile(manifest);
const cli = JSON.parse(original.toString());
const build = ["bun", "run", "--cwd", "apps/cli", "build"];
if (args.includes("--a")) {
  cli.version = version;
  cli.dependencies[metadata.name] = version;
  try {
    await writeFile(manifest, JSON.stringify(cli));
    await run(build, upstream);
  } finally {
    await writeFile(manifest, original);
  }
} else {
  if (cli.version !== version || cli.dependencies[metadata.name] !== version)
    throw new Error("Prepared CLI version differs from native/package.json; run bun run prepare:upstream");
  await run(build, upstream);
}
