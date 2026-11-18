import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { root } from "../common";
import { newer, stableVersion } from "./versions";

export type Pin = { repository: string; release: string; sha: string };
export type Api = (path: string) => Promise<any>;

export function githubApi(base = process.env.GITHUB_API_URL || "https://api.github.com", token = process.env.GITHUB_TOKEN || ""): Api {
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

export async function discoverUpstream(pin: Pin, api: Api) {
  const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/.exec(pin.repository)?.[1];
  if (!repository) throw new Error("Expected a GitHub upstream repository");
  stableVersion(pin.release);
  if (!/^[a-f0-9]{40}$/.test(pin.sha)) throw new Error("Pinned upstream must be a full commit SHA");
  let release = pin.release;
  const releases = await api(`/repos/${repository}/releases?per_page=100`);
  for (const item of releases) {
    if (!item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name) && newer(item.tag_name, release))
      release = item.tag_name;
  }
  const { sha } = await api(`/repos/${repository}/commits/${encodeURIComponent(release)}`);
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid upstream SHA");
  if (release === pin.release && sha !== pin.sha) throw new Error("Pinned upstream tag moved; manual review required");
  return { repository: pin.repository, release, sha, changed: sha !== pin.sha || release !== pin.release };
}

export async function checkUpstream(args: string[], options: { directory?: string; api?: Api; actions?: boolean } = {}) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false,
    options: { apply: { type: "boolean" } } });
  if (values.apply && (options.actions ?? process.env.GITHUB_ACTIONS === "true"))
    throw new Error("Upstream synchronization is local-only; GitHub Actions only validates and releases the pinned version");
  const directory = options.directory ?? root;
  const path = resolve(directory, "upstream.lock");
  const original = await Bun.file(path).text();
  const pin: Pin = JSON.parse(original);
  const candidate = await discoverUpstream(pin, options.api ?? githubApi());
  if (values.apply && candidate.changed) {
    if (await Bun.file(path).text() !== original) throw new Error("upstream.lock changed during discovery; retry after reviewing it");
    await Bun.write(path, JSON.stringify({ ...pin, release: candidate.release, sha: candidate.sha }, null, 2) + "\n");
  }
  const result = { ...candidate, applied: Boolean(values.apply && candidate.changed) };
  await mkdir(resolve(directory, ".work"), { recursive: true });
  await Bun.write(resolve(directory, ".work/candidate.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (import.meta.main) console.log(JSON.stringify(await checkUpstream(process.argv.slice(2))));
