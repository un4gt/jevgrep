import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { root, output, run } from "../../scripts/common";

// Use a disposable source snapshot. Publication is replaced with an observable
// local marker, so even the publish=true scenario cannot contact the registry.
const full = process.argv.includes("--full");
const selectedCase = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const cases = ["release-validation-only", "release-publish-after-validation", "release-failed-validation", "release-failed-compatibility", ...(full ? ["release-full-linux"] : [])];
if (selectedCase && !cases.includes(selectedCase)) throw new Error(`Unknown local Actions scenario: ${selectedCase}`);
const act = process.env.ACT_BINARY || "act";
const image = process.env.ACT_IMAGE || "emrank-jg-act:local";
// https://github.com/nektos/act/issues/6021: substitute v5 only in this snapshot.
const localArtifacts = (yaml: string) => yaml.replaceAll("actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
  "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4");
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
await run(["git", "init", "--initial-branch=main", "--quiet"], snapshot);
await run(["git", "add", "."], snapshot);
await run(["git", "-c", "user.name=Local Actions Test", "-c", "user.email=local@example.invalid", "commit", "--quiet", "-m", "Local workflow fixture"], snapshot);
await run(["git", "remote", "add", "origin", "https://github.com/local/actions-fixture.git"], snapshot);
const sourceSha = await output(["git", "rev-parse", "HEAD"], snapshot);
const event = { ref: "refs/heads/main", after: sourceSha, repository: {
  full_name: "local/actions-fixture", name: "actions-fixture", default_branch: "main", owner: { login: "local", name: "local" },
} };
const eventPath = join(workspace, "event.json"), empty = join(workspace, "empty");
await Bun.write(empty, "");
const releasePath = join(snapshot, ".github/workflows/release.yml");
type Job = { if?: string; needs?: string | string[]; uses?: string };
const release = Bun.YAML.parse(await Bun.file(releasePath).text()) as {
  name: string; on: { workflow_dispatch: unknown }; jobs: Record<string, Job>;
};
const candidateJobs = ["build", "seal", "install", "verify"];
const publishJobs = ["acceptance", "publish_candidate", "registry", "promote", "default_tag"];
const expectedJobs = ["compatibility", ...candidateJobs, ...publishJobs];
if (Object.keys(release.jobs).sort().join() !== [...expectedJobs].sort().join()
  || release.jobs.compatibility.uses !== "./.github/workflows/compatibility.yml") {
  throw new Error("Unexpected release graph: review its jobs before updating the local fixture");
}
// Copy only dependencies and conditions. No real release steps, Environment, credentials,
// shared environment, or external action can enter a local candidate/publish job.
const localJobs: Record<string, object> = {};
for (const id of expectedJobs) {
  const { if: condition, needs } = release.jobs[id];
  const gate = { ...(condition ? { if: condition } : {}), ...(needs ? { needs } : {}) };
  if (id === "compatibility") {
    localJobs[id] = { ...gate, uses: "./.github/workflows/compatibility.yml" };
  } else {
    const commands = [`echo LOCAL_JOB_${id}`];
    if (id === "acceptance") commands.push('test "$LOCAL_FAIL_VERIFY" != true');
    localJobs[id] = { ...gate, "runs-on": "ubuntu-24.04", steps: [{ run: commands.join("\n") }] };
  }
}
await Bun.write(releasePath, Bun.YAML.stringify({ name: release.name, on: release.on, jobs: localJobs }));
const compatible = join(snapshot, ".github/workflows/compatibility.yml");
const realCompatibility = localArtifacts(await Bun.file(compatible).text()).replace(
  "run: dbus-run-session -- bash scripts/verify/linux.sh",
  'run: |\n          chown -R runner:runner "$GITHUB_WORKSPACE" /opt/rust\n          sudo -E -H -u runner env "PATH=$PATH" dbus-run-session -- bash scripts/verify/linux.sh');
const results: { name: string; exitCode: number; passed: boolean; log: string }[] = [];
async function saveResults() {
  const summary = { workspace: relative(root, workspace).replaceAll("\\", "/"), image, sourceSha, upstream: pin,
    fullLinuxRequested: full, localUploadArtifact: "v5 (act issue #6021)", publicationStubbed: true, results };
  await Bun.write(join(workspace, "results.json"), JSON.stringify(summary, null, 2));
  await mkdir(resolve(root, "reports"), { recursive: true });
  await Bun.write(resolve(root, "reports/actions-local.json"), JSON.stringify(summary, null, 2));
}

async function scenario(name: string, publish: boolean, fail = false, isFull = false) {
  if (selectedCase && selectedCase !== name) return;
  // act expects dispatch values as strings; GitHub exposes typed inputs to jobs.
  await Bun.write(eventPath, JSON.stringify({ ...event, inputs: { publish: String(publish) } }));
  await Bun.write(compatible, isFull ? realCompatibility : await Bun.file(resolve(root, "tests/actions/verify-stub.yml")).text());
  const args = [act, "workflow_dispatch", "-C", snapshot, "-W", ".github/workflows/release.yml", "-e", eventPath,
    "-P", `ubuntu-latest=${image}`, "-P", `ubuntu-24.04=${image}`, "--matrix", "os:ubuntu-24.04", "--pull=false",
    "--container-architecture", "linux/amd64", "--container-daemon-socket", "-", "--artifact-server-path", artifacts, "--action-offline-mode",
    "--secret-file", empty, "--env-file", empty, "--var-file", empty, "--input-file", empty,
    "--input", `publish=${publish}`,
    ...(process.argv.includes("--verbose") ? ["--verbose"] : []),
    "--env", `LOCAL_FAIL_VERIFY=${fail}`, "--log-prefix-job-id"];
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
  const compatibilityRan = isFull ? log.includes("Linux upstream, OAuth and installed-package regression") : log.includes("| LOCAL_VERIFY");
  const expected = publish ? (fail ? ["acceptance"] : publishJobs) : (fail ? [] : candidateJobs);
  const observed = [...candidateJobs, ...publishJobs]
    .map(id => ({ id, position: log.indexOf(`| LOCAL_JOB_${id}`) }))
    .filter(job => job.position >= 0)
    .sort((left, right) => left.position - right.position)
    .map(job => job.id);
  const jobsMatch = observed.join(",") === expected.join(",");
  const passed = (fail ? exitCode !== 0 : exitCode === 0) && compatibilityRan === !publish && jobsMatch;
  results.push({ name, exitCode, passed, log: relative(root, logPath).replaceAll("\\", "/") });
  await saveResults();
  if (!passed) throw new Error(`Local Actions scenario failed: ${name}; see ${logPath}`);
}

await scenario("release-validation-only", false);
await scenario("release-publish-after-validation", true);
await scenario("release-failed-validation", true, true);
await scenario("release-failed-compatibility", false, true);
if (full && (!selectedCase || selectedCase === "release-full-linux")) {
  await scenario("release-full-linux", false, false, true);
  const archive = join(artifacts, "1", "compatibility-ubuntu-24.04", "compatibility-ubuntu-24.04.zip");
  const verification = JSON.parse(await output(["unzip", "-p", archive, "reports/verification.json"], snapshot));
  if (verification.platform !== "linux" || verification.upstream.sha !== pin.sha
    || !verification.evidence.length || verification.evidence.some((item: any) => item.passed !== true))
    throw new Error("Uploaded Linux verification report is incomplete or failed");
  await Bun.write(resolve(root, "reports/actions-linux-verification.json"), JSON.stringify(verification, null, 2));
}
console.log(`\nAll ${results.length} local Actions scenarios passed. Reports: ${workspace}`);
