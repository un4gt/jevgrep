import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root, upstream, lock, output, run } from "../common";
import { stableVersion } from "./versions";
const pin = await lock();
stableVersion(pin.release);
const sha = pin.sha;
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Upstream must be a full commit SHA");
await mkdir(resolve(root, ".work"), { recursive: true });
if (!await Bun.file(resolve(upstream, ".git/config")).exists()) {
  await run(["git", "clone", "--no-checkout", pin.repository, upstream]);
} else {
  if (await output(["git", "remote", "get-url", "origin"], upstream) !== pin.repository)
    throw new Error("Refusing to reuse a checkout with an unexpected origin");
  if (await output(["git", "status", "--porcelain", "--untracked-files=no"], upstream))
    throw new Error("Upstream checkout has tracked changes; preserve or move it before preparing");
}
await run(["git", "config", "core.autocrlf", "false"], upstream);
await run(["git", "fetch", "origin", sha], upstream);
await run(["git", "checkout", "--detach", sha], upstream);
// Install the unchanged upstream lock before adding our external package. The owned
// native package is copied by the build command; no upstream lock regeneration is needed.
await run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], upstream);
const patches = (await readdir(resolve(root, "patches"))).filter(p => p.endsWith(".patch")).sort();
if (patches.length !== 3) throw new Error("Expected exactly three overlay patches");
const overlayGit = ["git", "-c", "user.name=EMRank Overlay", "-c", "user.email=overlay@emrank.invalid"];
await run([...overlayGit, "am", "--3way", ...patches.map(p => resolve(root, "patches", p))], upstream);
// The upstream CLI and its tests both read this manifest. Record the fork's version
// in the disposable checkout so another prepare still detects actual user edits.
const native = await Bun.file(resolve(root, "native/package.json")).json();
const manifestPath = "apps/cli/package.json";
const manifest = Bun.file(resolve(upstream, manifestPath));
const cli = await manifest.json();
if (cli.version !== native.version || cli.dependencies[native.name] !== native.version) {
  cli.version = cli.dependencies[native.name] = native.version;
  await Bun.write(manifest, JSON.stringify(cli, null, 2) + "\n");
  await run([...overlayGit, "commit", "--only", "-m", "build: apply EMRank package version", "--", manifestPath], upstream);
}
if (await output(["git", "diff", sha, "--", "packages/core", "apps/cli/src/args.ts"], upstream))
  throw new Error("Overlay changed protected upstream core or argument parser");
await Bun.write(resolve(root, ".work/prepared.json"), JSON.stringify({ ...pin, sha, patches }, null, 2) + "\n");
