import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root, upstream, run } from "../common";
const native = await Bun.file(resolve(root, "native/package.json")).json();
const cli = await Bun.file(resolve(upstream, "apps/cli/package.json")).json();
if (cli.dependencies[native.name] !== native.version || Object.values(native.optionalDependencies).some(version => version !== native.version))
  throw new Error("CLI patch, native loader and platform package versions must match");
await run(["bun", "run", "build:native"]);
const dest = resolve(upstream, "node_modules/@emrank/jevgrep-native");
await mkdir(dest, { recursive: true });
for (const file of ["package.json", "index.js", "index.d.ts", "jevgrep-native.node"])
  await cp(resolve(root, "native", file), resolve(dest, file));
await cp(resolve(root, "overlay/emrank.ts"), resolve(upstream, "apps/cli/src/emrank.ts"));
await run(["bun", "run", "--cwd", "apps/cli", "build"], upstream);
