import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactName, decide, findVerifiedRun, recordJobName, testKey, type Api } from "../../scripts/upstream/state";

const sourceSha = "a".repeat(40), upstreamSha = "b".repeat(40);
const options = { repository: "example/overlay", sourceSha, defaultBranch: "main", channel: "release" as const,
  key: testKey("release", upstreamSha, sourceSha) };
const now = Date.parse("2026-10-31T00:00:00Z");
function fixture() {
  const artifact = { name: artifactName(options.key), expired: false, created_at: new Date(now - 60_000).toISOString(),
    workflow_run: { id: 42, head_sha: sourceSha, head_branch: "main" } };
  const run = { status: "completed", conclusion: "failure", head_sha: sourceSha, head_branch: "main",
    path: ".github/workflows/upstream-check.yml", repository: { full_name: options.repository },
    head_repository: { full_name: options.repository }, event: "schedule" };
  const job = { name: recordJobName, status: "completed", conclusion: "success" };
  const history: { workflow_runs: any[] } = { workflow_runs: [] };
  const api: Api = async path => {
    if (path.includes("/artifacts?")) return { artifacts: [artifact] };
    if (path.endsWith("/runs/42")) return run;
    if (path.includes("/runs/42/jobs?")) return { jobs: [job] };
    if (path.includes("/workflows/upstream-check.yml/runs?")) return history;
    throw new Error(`Unexpected API request: ${path}`);
  };
  return { artifact, run, job, history, api };
}

test("same upstream and local commits skip repeat tests but can recover missing PR creation", () => {
  expect(decide({ channel: "release", changed: true, verified: true, existingPr: false, force: false }))
    .toEqual({ need_test: false, need_update_pr: true });
  expect(decide({ channel: "release", changed: true, verified: true, existingPr: true, force: false }))
    .toEqual({ need_test: false, need_update_pr: false });
});

test("main checks new or failed candidates and never proposes a release", () => {
  expect(decide({ channel: "main", changed: false, verified: false, existingPr: false, force: false }))
    .toEqual({ need_test: true, need_update_pr: false });
  expect(decide({ channel: "main", changed: true, verified: true, existingPr: false, force: false }).need_test).toBe(false);
});

test("unchanged release is skipped; force_test overrides even a previous success", () => {
  expect(decide({ channel: "release", changed: false, verified: false, existingPr: false, force: false }))
    .toEqual({ need_test: false, need_update_pr: false });
  expect(decide({ channel: "release", changed: false, verified: true, existingPr: true, force: true }))
    .toEqual({ need_test: true, need_update_pr: false });
});

test("upstream changes, local changes and channels have distinct test records", () => {
  const keys = [testKey("release", upstreamSha, sourceSha), testKey("release", sourceSha, sourceSha),
    testKey("release", upstreamSha, upstreamSha), testKey("main", upstreamSha, sourceSha)];
  expect(new Set(keys).size).toBe(4);
  expect(() => testKey("main", "main", sourceSha)).toThrow();
});

test("successful tests survive a later failed PR creation", async () => {
  expect(await findVerifiedRun(fixture().api, options, now)).toBe(42);
});

test("a later failed force-test invalidates older success; failures before that success do not", async () => {
  const f = fixture();
  const failure = { ...f.run, id: 43, conclusion: "failure", updated_at: new Date(now).toISOString() };
  f.history.workflow_runs.push(failure);
  expect(await findVerifiedRun(f.api, options, now)).toBeUndefined();
  failure.updated_at = new Date(now - 120_000).toISOString();
  expect(await findVerifiedRun(f.api, options, now)).toBe(42);
});

test.each([
  ["expired artifact", (f: ReturnType<typeof fixture>) => { f.artifact.expired = true; }],
  ["old record", (f: ReturnType<typeof fixture>) => { f.artifact.created_at = new Date(now - 7 * 86_400_000).toISOString(); }],
  ["wrong key", (f: ReturnType<typeof fixture>) => { f.artifact.name = "untrusted"; }],
  ["different source", (f: ReturnType<typeof fixture>) => { f.artifact.workflow_run.head_sha = upstreamSha; }],
  ["different branch", (f: ReturnType<typeof fixture>) => { f.run.head_branch = "feature"; }],
  ["forked run", (f: ReturnType<typeof fixture>) => { f.run.head_repository.full_name = "fork/overlay"; }],
  ["unrelated workflow", (f: ReturnType<typeof fixture>) => { f.run.path = ".github/workflows/other.yml"; }],
  ["pull request event", (f: ReturnType<typeof fixture>) => { f.run.event = "pull_request"; }],
  ["unfinished run", (f: ReturnType<typeof fixture>) => { f.run.status = "in_progress"; }],
  ["failed record job", (f: ReturnType<typeof fixture>) => { f.job.conclusion = "failure"; }],
  ["cancelled record job", (f: ReturnType<typeof fixture>) => { f.job.conclusion = "cancelled"; }],
])("rejects %s", async (_label, mutate) => {
  const f = fixture(); mutate(f);
  expect(await findVerifiedRun(f.api, options, now)).toBeUndefined();
});

test("missing history is a cache miss; API permission errors do not masquerade as a verified run", async () => {
  expect(await findVerifiedRun(async () => ({ artifacts: [] }), options, now)).toBeUndefined();
  await expect(findVerifiedRun(async () => { throw new Error("HTTP 403"); }, options, now)).rejects.toThrow("HTTP 403");
});

test("detection CLI writes reusable job outputs for an already verified candidate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upstream-output-"));
  const f = fixture();
  f.artifact.created_at = new Date().toISOString();
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname + url.search;
    requests.push(path);
    if (url.pathname.endsWith("/releases")) return Response.json([{ tag_name: "v99.0.0", draft: false, prerelease: false }]);
    if (url.pathname.includes("/commits/")) return Response.json({ sha: upstreamSha });
    if (url.pathname.endsWith("/pulls")) return Response.json([]);
    return Response.json(await f.api(path));
  } });
  try {
    await Bun.write(join(dir, "event.json"), JSON.stringify({ repository: { default_branch: "main" } }));
    const child = Bun.spawn([process.execPath, "scripts/upstream/check.ts"], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GITHUB_API_URL: server.url.origin, GITHUB_TOKEN: "", GITHUB_OUTPUT: join(dir, "outputs"),
        GITHUB_REPOSITORY: options.repository, GITHUB_SHA: sourceSha, GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_SERVER_URL: "https://github.com", FORCE_TEST: "false" } });
    expect(await child.exited).toBe(0);
    const outputs = await Bun.file(join(dir, "outputs")).text();
    expect(outputs).toContain("need_test=false\n");
    expect(outputs).toContain("need_update_pr=true\n");
    expect(outputs).toContain("verified_run_url=https://github.com/example/overlay/actions/runs/42\n");
    expect(requests.some(path => path.includes("head=example%3Aupstream%2Fv99.0.0-"))).toBe(true);
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
