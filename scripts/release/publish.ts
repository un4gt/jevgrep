import { resolve } from "node:path";
import { run, root } from "../common";
// The workflow supplies only artifacts from its successful verification jobs.
const artifactRoot = process.env.EMRANK_RELEASE_ARTIFACTS ?? "verified";
const files = [...new Bun.Glob(`${artifactRoot}/**/*.tgz`).scanSync({ cwd: root })];
const selected = new Map<string, string>();
for (const file of files.sort()) {
  const name = file.split(/[\\/]/).at(-1)!;
  if (selected.has(name)) {
    const a = await new Bun.Archive(await Bun.file(resolve(root, selected.get(name)!)).arrayBuffer()).files();
    const b = await new Bun.Archive(await Bun.file(resolve(root, file)).arrayBuffer()).files();
    if (a.size !== b.size) throw new Error(`Platforms produced different contents for ${name}`);
    for (const [path, value] of a) {
      const other = b.get(path);
      if (!other || !Buffer.from(await value.arrayBuffer()).equals(Buffer.from(await other.arrayBuffer())))
        throw new Error(`Platforms produced different contents for ${name}: ${path}`);
    }
    // Archive metadata can differ by OS; both archives have been installed and
    // tested. Select the Linux archive for the shared loader and CLI packages.
    if (file.includes("ubuntu") || file.includes("/linux/")) selected.set(name, file);
  } else selected.set(name, file);
}
if (selected.size !== 4) throw new Error("Expected CLI, native loader and two platform archives");
const rank = (name: string) => /native-(win32|linux)/.test(name) ? 0 : name.includes("native") ? 1 : 2;
for (const [name, file] of [...selected].sort(([a], [b]) => rank(a)-rank(b))) {
  console.log(`${process.argv.includes("--check") ? "Verified" : "Publishing"} ${name}`);
  if (!process.argv.includes("--check")) await run(["bun", "publish", resolve(root, file), "--access", "public", "--ignore-scripts"]);
}
