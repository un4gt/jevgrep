import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { root, output, run } from "../../scripts/common";
import { recordJobName } from "../../scripts/upstream/state";

// Run in a disposable source snapshot: no credentials, remote writes, or changes
// to the developer's Git history. Only the full case executes real compatibility.
const full = process.argv.includes("--full");
const selectedCase = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const act = process.env.ACT_BINARY || "act";
const image = process.env.ACT_IMAGE || "emrank-jg-act:local";
// https://github.com/nektos/act/issues/6021: act's blob signatures are not
// compatible with upload-artifact v6. Change only the disposable test snapshot.
const localArtifacts = (yaml: string) => yaml.replaceAll("actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
  "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4"); // v5
await mkdir(resolve(root, ".work"), { recursive: true });
const workspace = await mkdtemp(resolve(root, ".work/act-"));
const snapshot = join(workspace, "repository"), logs = join(workspace, "logs"), artifacts = join(workspace, "artifacts");
await mkdir(snapshot); await mkdir(logs); await mkdir(artifacts);
await mkdir(join(artifacts, "1"));
for (const name of [".github", ".gitattributes", ".gitignore", "native", "scripts", "tests", "docs", "overlay", "patches",
  "package.json", "bun.lock", "tsconfig.json", "upstream.lock", "README.md", "LICENSE"]) {
  await cp(resolve(root, name), join(snapshot, name), { recursive: true,
    filter: path => basename(path) !== "target" && !path.endsWith(".node") });
}
const pin = await Bun.file(join(snapshot, "upstream.lock")).json();
// Simulate discovering the real pinned version from an older installation.
await Bun.write(join(snapshot, "upstream.lock"), JSON.stringify({ ...pin, release: "v0.0.0", sha: "0".repeat(40) }));
await run(["git", "init", "--initial-branch=main", "--quiet"], snapshot);
await run(["git", "add", "."], snapshot);
await run(["git", "-c", "user.name=Local Actions Test", "-c", "user.email=local@example.invalid", "commit", "--quiet", "-m", "Local workflow fixture"], snapshot);
await run(["git", "remote", "add", "origin", "https://github.com/local/actions-fixture.git"], snapshot);
const sourceSha = await output(["git", "rev-parse", "HEAD"], snapshot);
const repository = "local/actions-fixture";
let mode = "new", channel = "release";
const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (request.method !== "GET") return new Response("Local fixture is read-only", { status: 405 });
  if (url.pathname.endsWith("/releases")) return Response.json(mode === "unchanged" ? [] : [{ tag_name: pin.release, draft: false, prerelease: false }]);
  if (url.pathname.includes("/commits/")) return Response.json({ sha: mode === "unchanged" ? "0".repeat(40) : pin.sha });
  if (url.pathname.endsWith("/pulls")) return Response.json(mode === "existing-pr" ? [{
    head: { ref: `upstream/${pin.release}-${pin.sha.slice(0, 12)}`, repo: { full_name: repository } },
  }] : []);
  if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: ["cached", "existing-pr", "force", "failed-history"].includes(mode) ? [{
    name: url.searchParams.get("name"), expired: false, created_at: new Date(Date.now() - 60_000).toISOString(),
    workflow_run: { id: 42, head_sha: sourceSha, head_branch: "main" },
  }] : [] });
  if (url.pathname.endsWith("/runs/42")) return Response.json({ status: "completed", conclusion: "success", head_sha: sourceSha,
    head_branch: "main", path: `.github/workflows/${channel === "main" ? "upstream-main" : "upstream-check"}.yml`,
    repository: { full_name: repository }, head_repository: { full_name: repository }, event: "schedule" });
  if (url.pathname.endsWith("/runs/42/jobs")) return Response.json({ jobs: [{ name: recordJobName, status: "completed", conclusion: "success" }] });
  if (url.pathname.includes("/workflows/") && url.pathname.endsWith("/runs")) return Response.json({ workflow_runs: mode === "failed-history" ? [{
    id: 43, status: "completed", conclusion: "failure", head_sha: sourceSha, head_branch: "main",
    head_repository: { full_name: repository }, event: "workflow_dispatch", updated_at: new Date().toISOString(),
  }] : [] });
  return new Response(`Unexpected fixture request: ${url.pathname}`, { status: 404 });
} });
const event = { ref: "refs/heads/main", after: sourceSha, inputs: {}, repository: {
  full_name: repository, name: "actions-fixture", default_branch: "main", owner: { login: "local", name: "local" },
} };
const eventPath = join(workspace, "event.json"), empty = join(workspace, "empty");
await Bun.write(empty, "");
for (const workflow of ["upstream-check.yml", "upstream-main.yml"]) {
  const path = join(snapshot, ".github/workflows", workflow);
  let content = localArtifacts(await Bun.file(path).text());
  const fixtureHost = process.env.ACT_FIXTURE_HOST || (process.platform === "win32" ? "host.docker.internal" : "127.0.0.1");
  content = content.replace("GITHUB_TOKEN: ${{ github.token }}", `GITHUB_TOKEN: \"\"\n          GITHUB_API_URL: http://${fixtureHost}:${server.port}`);
  content = content.replace("run: bun scripts/upstream/propose.ts", "run: echo LOCAL_PROPOSE_PR");
  await Bun.write(path, content);
}
const compatible = join(snapshot, ".github/workflows/compatibility.yml");
const realCompatibility = localArtifacts(await Bun.file(compatible).text()).replace(
  "run: dbus-run-session -- bash scripts/verify/linux.sh",
  'run: |\n          chown -R runner:runner "$GITHUB_WORKSPACE" /opt/rust\n          sudo -E -H -u runner env "PATH=$PATH" dbus-run-session -- bash scripts/verify/linux.sh');
const results: { name: string; exitCode: number; passed: boolean; log: string }[] = [];
async function saveResults() {
  const summary = { workspace: relative(root, workspace).replaceAll("\\", "/"), image, sourceSha, upstream: pin,
    fullLinuxRequested: full, localUploadArtifact: "v5 (act issue #6021)", results };
  await Bun.write(join(workspace, "results.json"), JSON.stringify(summary, null, 2));
  await mkdir(resolve(root, "reports"), { recursive: true });
  await Bun.write(resolve(root, "reports/actions-local.json"), JSON.stringify(summary, null, 2));
}

async function scenario(name: string, state: string, expected: { verify: boolean; propose: boolean; fail?: boolean }, isFull = false) {
  if (selectedCase && selectedCase !== name) return;
  mode = state;
  channel = name.startsWith("main") ? "main" : "release";
  // GitHub's event payload stores dispatch inputs as strings; `inputs` exposes
  // typed booleans. act falls back to the default if JSON supplies a boolean here.
  await Bun.write(eventPath, JSON.stringify({ ...event, inputs: { force_test: state === "force" ? "true" : "false" } }));
  await Bun.write(compatible, isFull ? realCompatibility : await Bun.file(resolve(root, "tests/actions/verify-stub.yml")).text());
  const workflow = channel === "main" ? "upstream-main.yml" : "upstream-check.yml";
  const args = [act, "workflow_dispatch", "-C", snapshot, "-W", `.github/workflows/${workflow}`, "-e", eventPath,
    "-P", `ubuntu-latest=${image}`, "-P", `ubuntu-24.04=${image}`, "--matrix", "os:ubuntu-24.04", "--pull=false",
    "--container-architecture", "linux/amd64", "--container-daemon-socket", "-", "--artifact-server-path", artifacts, "--action-offline-mode",
    "--secret-file", empty, "--env-file", empty, "--var-file", empty, "--input-file", empty,
    "--input", `force_test=${state === "force" ? "true" : "false"}`,
    ...(process.argv.includes("--verbose") ? ["--verbose"] : []),
    "--env", `LOCAL_FAIL_VERIFY=${expected.fail ? "true" : "false"}`, "--log-prefix-job-id"];
  console.log(`\nLocal Actions scenario: ${name}`);
  const logPath = join(logs, `${name}.log`), writer = Bun.file(logPath).writer();
  const child = Bun.spawn(args, { cwd: snapshot, stdout: "pipe", stderr: "pipe", timeout: 60 * 60_000 });
  let log = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) { const text = decoder.decode(bytes, { stream: true }); log += text; writer.write(text); process.stdout.write(text); }
  };
  await Promise.all([collect(child.stdout), collect(child.stderr)]);
  const exitCode = await child.exited;
  await writer.end();
  const verified = isFull ? log.includes("Linux upstream, OAuth and installed-package regression") : log.includes("| LOCAL_VERIFY");
  const proposed = log.includes("| LOCAL_PROPOSE_PR");
  const remembered = log.includes("⭐ Run Main Write record only after both platforms pass");
  const passed = (expected.fail ? exitCode !== 0 : exitCode === 0) && verified === expected.verify && proposed === expected.propose
    && remembered === (expected.verify && !expected.fail);
  results.push({ name, exitCode, passed, log: relative(root, logPath).replaceAll("\\", "/") });
  await saveResults();
  if (!passed) throw new Error(`Local Actions scenario failed: ${name}; see ${logPath}`);
}

try {
  await scenario("release-new", "new", { verify: true, propose: true });
  await scenario("release-cached-recover-pr", "cached", { verify: false, propose: true });
  await scenario("release-existing-pr", "existing-pr", { verify: false, propose: false });
  await scenario("release-unchanged", "unchanged", { verify: false, propose: false });
  await scenario("release-failed-tests", "new", { verify: true, propose: false, fail: true });
  await scenario("release-force-failed-tests", "force", { verify: true, propose: false, fail: true });
  await scenario("release-retry-after-failure", "failed-history", { verify: true, propose: true });
  await scenario("main-cached", "cached", { verify: false, propose: false });
  await scenario("main-force", "force", { verify: true, propose: false });
  if (full) {
    if (!selectedCase || selectedCase === "release-full-linux") {
      await scenario("release-full-linux", "new", { verify: true, propose: true }, true);
      const archive = join(artifacts, "1", "compatibility-ubuntu-24.04", "compatibility-ubuntu-24.04.zip");
      const verification = JSON.parse(await output(["unzip", "-p", archive, "reports/verification.json"], snapshot));
      if (verification.platform !== "linux" || verification.upstream.sha !== pin.sha
        || !verification.evidence.length || verification.evidence.some((item: any) => item.passed !== true))
        throw new Error("Uploaded Linux verification report is incomplete or failed");
      await Bun.write(resolve(root, "reports/actions-linux-verification.json"), JSON.stringify(verification, null, 2));
    }
    // The previous case exercises real build/tests/upload; this case verifies
    // the GitHub metadata contract that act's local artifact server does not expose.
    await scenario("release-full-repeat", "cached", { verify: false, propose: true });
  }
  console.log(`\nAll ${results.length} local Actions scenarios passed. Reports: ${workspace}`);
} finally { server.stop(true); }
