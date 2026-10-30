import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "../common";

export type Channel = "release" | "main";
export type Api = (path: string) => Promise<any>;
export const recordJobName = "Remember successful upstream validation";
export const stateLifetimeDays = 7;

export function testKey(channel: Channel, upstreamSha: string, sourceSha: string) {
  if (![upstreamSha, sourceSha].every(sha => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("Validation requires full upstream and source commit SHAs");
  return createHash("sha256").update(`v1\n${channel}\n${upstreamSha}\n${sourceSha}`).digest("hex");
}

export const artifactName = (key: string) => `upstream-verified-v1-${key}`;
export const updateBranch = (release: string, sha: string) => `upstream/${release}-${sha.slice(0, 12)}`;

export function githubApi(base = "https://api.github.com", token = ""): Api {
  return async path => {
    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub lookup failed: HTTP ${response.status} (${path})`);
    return response.json();
  };
}

// Artifact names alone are insufficient: only the default branch's matching
// workflow/source revision and a successfully finished record job can vouch for it.
// A later PR-creation failure does not invalidate already successful tests.
export async function findVerifiedRun(api: Api, options: {
  repository: string; sourceSha: string; defaultBranch: string; channel: Channel; key: string;
}, now = Date.now()): Promise<number | undefined> {
  const { repository, sourceSha, defaultBranch, channel, key } = options;
  const prefix = `/repos/${repository}/actions`;
  const name = artifactName(key);
  const listing = await api(`${prefix}/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
  const workflow = `.github/workflows/${channel === "main" ? "upstream-main" : "upstream-check"}.yml`;
  for (const artifact of listing.artifacts) {
    const created = Date.parse(artifact.created_at);
    if (artifact.name !== name || artifact.expired || !Number.isFinite(created)
      || created > now || now - created >= stateLifetimeDays * 86_400_000
      || artifact.workflow_run?.head_sha !== sourceSha
      || artifact.workflow_run?.head_branch !== defaultBranch) continue;
    const id = artifact.workflow_run.id;
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const run = await api(`${prefix}/runs/${id}`);
    if (run.status !== "completed" || run.head_sha !== sourceSha || run.head_branch !== defaultBranch
      || run.path !== workflow || run.repository?.full_name !== repository
      || run.head_repository?.full_name !== repository
      || !["schedule", "workflow_dispatch"].includes(run.event)) continue;
    const jobs = await api(`${prefix}/runs/${id}/jobs?filter=latest&per_page=100`);
    if (jobs.jobs.some((job: any) => job.name === recordJobName && job.status === "completed" && job.conclusion === "success")) {
      // A later failed/aborted validation (including force_test) must not let an
      // older green record silently revive the candidate. Conservatively re-test
      // after any later unsuccessful run of this workflow at the same source SHA.
      const workflowFile = channel === "main" ? "upstream-main.yml" : "upstream-check.yml";
      const history = await api(`${prefix}/workflows/${workflowFile}/runs?head_sha=${sourceSha}&per_page=100`);
      if (history.workflow_runs.some((recent: any) => recent.id !== id && recent.status === "completed"
        && ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(recent.conclusion)
        && recent.head_sha === sourceSha && recent.head_branch === defaultBranch
        && recent.head_repository?.full_name === repository && ["schedule", "workflow_dispatch"].includes(recent.event)
        && Date.parse(recent.updated_at) > created)) return undefined;
      return id;
    }
  }
}

export function decide(options: { channel: Channel; changed: boolean; verified: boolean; existingPr: boolean; force: boolean }) {
  return {
    need_test: options.force || ((options.channel === "main" || options.changed) && !options.verified),
    need_update_pr: options.channel === "release" && options.changed && !options.existingPr,
  };
}

if (import.meta.main) {
  const channel = process.env.UPSTREAM_CHANNEL as Channel;
  if (!["release", "main"].includes(channel)) throw new Error("Invalid upstream channel");
  const key = testKey(channel, process.env.UPSTREAM_SHA!, process.env.GITHUB_SHA!);
  if (key !== process.env.TEST_KEY) throw new Error("Validation record does not match tested commits");
  await mkdir(resolve(root, ".work"), { recursive: true });
  await Bun.write(resolve(root, ".work/upstream-verified.json"), JSON.stringify({
    schema: 1, key, channel, upstream_sha: process.env.UPSTREAM_SHA, source_sha: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID,
  }, null, 2) + "\n");
}
