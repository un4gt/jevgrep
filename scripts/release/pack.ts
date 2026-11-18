import { cp, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { root, upstream, run, output } from "../common";
const fixture = process.argv.includes("--fixture");
const oauthOnly = process.argv.includes("--oauth-only");
if (oauthOnly && !fixture) throw new Error("--oauth-only is only valid for protocol fixture installation checks");
const binaryPath = resolve(process.env.EMRANK_BINARY_DIR || resolve(root,"native"),"jevgrep-native.node");
const info = JSON.parse(await output(["node","-e","console.log(JSON.stringify(require(process.argv[1]).buildInfo()))",binaryPath]));
const expected = fixture ? "fixture" : process.argv.includes("--a") ? "A" : process.argv.includes("--unregistered") ? "unregistered" : "release";
if (info.kind !== expected) throw new Error("Native build mode does not match requested package mode");
const restricted = expected !== "release";
const staging = await mkdtemp(resolve(root, ".work/pack-"));
const scratch = await mkdtemp(join(tmpdir(), "emrank-install-"));
const platform = process.platform === "win32" ? "win32-x64-msvc" : "linux-x64-gnu";
const artifacts = process.env.EMRANK_ARTIFACT_DIR ? resolve(process.env.EMRANK_ARTIFACT_DIR) : fixture ? resolve(root, ".work/fixture-packages", platform) : resolve(root, "artifacts");
if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform)) throw new Error("Unsupported release target");
try {
  await mkdir(artifacts, { recursive: true });
  const native = await Bun.file(resolve(root, "native/package.json")).json();
  const cli = await Bun.file(resolve(upstream, "apps/cli/package.json")).json();
  cli.repository = native.repository;
  native.version = cli.version = info.version; cli.dependencies[native.name] = info.version;
  for (const name of Object.keys(native.optionalDependencies)) native.optionalDependencies[name] = info.version;
  if (restricted) { cli.private = native.private = true; delete cli.publishConfig; delete native.publishConfig; }
  delete cli.devDependencies; delete cli.scripts;
  const platformName = `${native.name}-${platform}`;
  const platformDir = join(staging, "platform"), nativeDir = join(staging, "native"), cliDir = join(staging, "cli");
  await mkdir(platformDir, { recursive: true }); await mkdir(nativeDir); await mkdir(cliDir);
  await Bun.write(join(platformDir, "package.json"), JSON.stringify({ name: platformName, version: native.version,
    main: "jevgrep-native.node", files: ["jevgrep-native.node", "LICENSE"], license: "MIT", repository: native.repository, os: [process.platform], cpu: ["x64"],
    ...(process.platform === "linux" ? { libc: ["glibc"] } : {}), emrankProtocolTestBuild: fixture,
    ...(restricted ? { private: true } : { publishConfig: { access: "public" } }) }, null, 2));
  await cp(binaryPath, join(platformDir, "jevgrep-native.node"));
  for (const file of ["index.js", "index.d.ts"]) await cp(resolve(root, "native", file), join(nativeDir, file));
  await Bun.write(join(nativeDir,"package.json"),JSON.stringify(native,null,2));
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
  await cp(resolve(root, "LICENSE"), join(cliDir, "LICENSE"));
  await cp(resolve(root, "README.md"), join(cliDir, "README.md"));
  const archive = (name: string, version: string) => resolve(artifacts, `${name.replace("@", "").replaceAll("/", "-")}-${version}.tgz`);
  const platformTar = archive(platformName, native.version), nativeTar = archive(native.name, native.version), cliTar = archive(cli.name, cli.version);
  for (const [dir, file] of [[platformDir, platformTar], [nativeDir, nativeTar], [cliDir, cliTar]])
    await run(["bun", "pm", "pack", "--ignore-scripts", "--filename", file!], dir!);
  await Bun.write(join(scratch, "package.json"), JSON.stringify({ private: true, dependencies: { [cli.name]: `file:${cliTar}` },
    overrides: { [native.name]: `file:${nativeTar}`, [platformName]: `file:${platformTar}` } }, null, 2));
  // The other platform's optional package may not be published yet. Resolve
  // only that absence locally; current-platform packages must use the tarballs
  // above, and ordinary dependencies still use the configured public registry.
  const absentPlatforms = new Set(Object.keys(native.optionalDependencies).filter(name => name !== platformName));
  const unexpected: string[] = [];
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (request.method !== "GET" || !absentPlatforms.has(name)) unexpected.push(name);
    return Response.json({ error: "Optional platform package is not part of this installation fixture" }, { status: 404 });
  } });
  try {
    await Bun.write(join(scratch, "bunfig.toml"), `[install.scopes]\n"@emrank" = "http://127.0.0.1:${registry.port}"\n`);
    await run(["bun", "install", "--ignore-scripts"], scratch);
    if (unexpected.length) throw new Error("Installed package tried to resolve an EMRank dependency outside the supplied tarballs");
  } finally { registry.stop(true); }
  const installedCli = join(scratch, "node_modules/@emrank/jevgrep/dist/bin/index.js");
  await run(["node", installedCli, "--help"], scratch);
  // Reuse the complete command and OAuth suite with only the entry point changed:
  // no source imports, global installation or developer .node fallback.
  if (fixture || expected === "unregistered") await run(["bun", "test", "--timeout", "60000", ...(fixture ? [oauthOnly ? "tests/emrank" : "tests"] : ["tests/upstream-compat/commands.test.ts", "tests/emrank/command.test.ts", "tests/emrank/production.test.ts"])], root,
    { JG_TEST_CLI: installedCli, EMRANK_TEST_EXPECT_FIXTURE: String(fixture) });
  if ((await output(["node",installedCli,"--version"],scratch)).replace(/^jg\s+|^v/, "") !== info.version) throw new Error("Installed CLI version mismatch");
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
