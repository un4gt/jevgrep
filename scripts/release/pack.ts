import { cp, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { root, upstream, run } from "../common";
const staging = await mkdtemp(resolve(root, ".work/pack-"));
const scratch = await mkdtemp(join(tmpdir(), "emrank-install-"));
const artifacts = resolve(root, "artifacts");
const platform = process.platform === "win32" ? "win32-x64-msvc" : "linux-x64-gnu";
if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform)) throw new Error("Unsupported release target");
try {
  await mkdir(artifacts, { recursive: true });
  const native = await Bun.file(resolve(root, "native/package.json")).json();
  const cli = await Bun.file(resolve(upstream, "apps/cli/package.json")).json();
  delete cli.devDependencies; delete cli.scripts;
  // Keep upstream's version visible; the independent registry scope avoids collision.
  const platformName = `${native.name}-${platform}`;
  const platformDir = join(staging, "platform"), nativeDir = join(staging, "native"), cliDir = join(staging, "cli");
  await mkdir(platformDir, { recursive: true }); await mkdir(nativeDir); await mkdir(cliDir);
  await Bun.write(join(platformDir, "package.json"), JSON.stringify({ name: platformName, version: native.version,
    main: "jevgrep-native.node", files: ["jevgrep-native.node", "LICENSE"], license: "MIT", os: [process.platform], cpu: ["x64"],
    ...(process.platform === "linux" ? { libc: ["glibc"] } : {}), publishConfig: { access: "public" } }, null, 2));
  await cp(resolve(root, "native/jevgrep-native.node"), join(platformDir, "jevgrep-native.node"));
  for (const file of ["index.js", "index.d.ts", "package.json"]) await cp(resolve(root, "native", file), join(nativeDir, file));
  for (const dir of [platformDir, nativeDir]) await cp(resolve(root, "LICENSE"), join(dir, "LICENSE"));
  await cp(resolve(upstream, "apps/cli/dist"), join(cliDir, "dist"), { recursive: true });
  // Git checkouts can use CRLF on Windows. Ship the repository's LF text on
  // every platform; WASM and native binaries are never decoded or rewritten.
  for (const relative of new Bun.Glob("dist/**/*").scanSync({ cwd: cliDir, onlyFiles: true })) {
    if (!/(?:\.(?:mjs|js|md|txt)|LICENSE)$/.test(relative)) continue;
    const file = join(cliDir, relative);
    await Bun.write(file, (await Bun.file(file).text()).replaceAll("\r\n", "\n"));
  }
  await Bun.write(join(cliDir, "package.json"), JSON.stringify(cli, null, 2));
  await cp(resolve(root, "README.md"), join(cliDir, "README.md"));
  const archive = (name: string, version: string) => resolve(artifacts, `${name.replace("@", "").replaceAll("/", "-")}-${version}.tgz`);
  const platformTar = archive(platformName, native.version), nativeTar = archive(native.name, native.version), cliTar = archive(cli.name, cli.version);
  for (const [dir, file] of [[platformDir, platformTar], [nativeDir, nativeTar], [cliDir, cliTar]])
    await run(["bun", "pm", "pack", "--ignore-scripts", "--filename", file!], dir!);
  await Bun.write(join(scratch, "package.json"), JSON.stringify({ private: true, dependencies: { [cli.name]: `file:${cliTar}` },
    overrides: { [native.name]: `file:${nativeTar}`, [platformName]: `file:${platformTar}` } }, null, 2));
  await run(["bun", "install", "--ignore-scripts"], scratch);
  const installedCli = join(scratch, "node_modules/@emrank/jevgrep/dist/bin/index.js");
  await run(["node", installedCli, "--help"], scratch);
  // Reuse the complete command and OAuth suite with only the entry point changed:
  // no source imports, global installation or developer .node fallback.
  await run(["bun", "test", "--timeout", "60000", "tests"], root, { JG_TEST_CLI: installedCli });
  const checksumLines = [];
  for (const name of (await readdir(artifacts)).filter(n => n.endsWith(".tgz")).sort()) {
    const bytes = await Bun.file(resolve(artifacts, name)).arrayBuffer();
    checksumLines.push(`${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  await Bun.write(resolve(artifacts, `SHA256SUMS-${platform}`), checksumLines.join("\n") + "\n");
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
