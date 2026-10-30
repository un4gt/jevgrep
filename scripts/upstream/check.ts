import { resolve } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { root, lock } from "../common";
import { newer } from "./versions";
import { decide, findVerifiedRun, githubApi, testKey, updateBranch, type Channel } from "./state";
const pin = await lock();
const api = githubApi(process.env.GITHUB_API_URL, process.env.GITHUB_TOKEN);
const upstreamRepository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/.exec(pin.repository)?.[1];
if (!upstreamRepository) throw new Error("Expected a GitHub upstream repository");
const main = process.argv.includes("--main");
const channel: Channel = main ? "main" : "release";
const releases = main ? [] : await api(`/repos/${upstreamRepository}/releases?per_page=100`);
const stable = releases.filter((r: any) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name));
let release = main ? "main" : pin.release;
for (const item of stable) if (newer(item.tag_name, release)) release = item.tag_name;
if (typeof release !== "string" || !/^(main|v\d+\.\d+\.\d+)$/.test(release)) throw new Error("Expected a stable upstream release");
const { sha } = await api(`/repos/${upstreamRepository}/commits/${encodeURIComponent(release)}`);
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid upstream SHA");
if (release === pin.release && sha !== pin.sha) throw new Error("Pinned upstream tag moved; manual review required");
const changed = sha !== pin.sha;
const repository = process.env.GITHUB_REPOSITORY;
const sourceSha = process.env.GITHUB_SHA;
const event = process.env.GITHUB_EVENT_PATH ? await Bun.file(process.env.GITHUB_EVENT_PATH).json() : {};
const defaultBranch = event.repository?.default_branch;
let key = "", verifiedRun: number | undefined, existingPr = false;
if (repository && sourceSha) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  key = testKey(channel, sha, sourceSha);
  if ((main || changed || process.env.FORCE_TEST === "true") && defaultBranch
    && process.env.GITHUB_REF === `refs/heads/${defaultBranch}`) {
    verifiedRun = await findVerifiedRun(api, { repository, sourceSha, defaultBranch, channel, key });
  }
  if (!main && changed) {
    const head = `${repository.split("/")[0]}:${updateBranch(release, sha)}`;
    const prs = await api(`/repos/${repository}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=100`);
    // A deliberately closed update PR must not be recreated every day.
    existingPr = prs.some((pr: any) => pr.head?.ref === updateBranch(release, sha) && pr.head?.repo?.full_name === repository);
  }
}
const decision = decide({ channel, changed, verified: verifiedRun !== undefined, existingPr, force: process.env.FORCE_TEST === "true" });
const verified_run_url = verifiedRun ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}/actions/runs/${verifiedRun}` : "";
const candidate = { repository: pin.repository, release, sha, changed, ...decision, test_key: key, verified_run_url };
await mkdir(resolve(root, ".work"), { recursive: true });
await Bun.write(resolve(root, ".work/candidate.json"), JSON.stringify(candidate, null, 2) + "\n");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
  Object.entries(candidate).filter(([name]) => name !== "repository").map(([name, value]) => `${name}=${value}\n`).join(""));
console.log(JSON.stringify(candidate));
