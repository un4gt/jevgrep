import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUpstream, discoverUpstream, githubApi, type Pin } from "../../scripts/upstream/check";

const pin: Pin = { repository: "https://github.com/example/upstream.git", release: "v1.2.3", sha: "a".repeat(40) };
const nextSha = "b".repeat(40);
function fixture(releases: any[] = [{ tag_name: "v1.3.0" }], sha = nextSha) {
  const requests: string[] = [];
  return { requests, api: async (path: string) => {
    requests.push(path);
    if (path === "/repos/example/upstream/releases?per_page=100") return releases;
    if (path.startsWith("/repos/example/upstream/commits/")) return { sha };
    throw new Error(`Unexpected request: ${path}`);
  } };
}
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "jg-sync-"));
  const path = join(directory, "upstream.lock"), original = JSON.stringify(pin, null, 2) + "\n";
  await Bun.write(path, original);
  return { directory, path, original, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("discovery chooses the latest stable release without Actions history or PR lookups", async () => {
  const f = fixture([{ tag_name: "v1.3.0" }, { tag_name: "v3.0.0", draft: true },
    { tag_name: "v2.0.0", prerelease: true }, { tag_name: "v9.0.0-rc.1" }, { tag_name: "v1.4.0" }]);
  expect(await discoverUpstream(pin, f.api)).toEqual({ ...pin, release: "v1.4.0", sha: nextSha, changed: true });
  expect(f.requests).toEqual(["/repos/example/upstream/releases?per_page=100", "/repos/example/upstream/commits/v1.4.0"]);
});

test("no newer stable release leaves the pin unchanged", async () => {
  const f = fixture([{ tag_name: "v1.0.0" }], pin.sha);
  expect(await discoverUpstream(pin, f.api)).toEqual({ ...pin, changed: false });
});

test("main is rejected for both checking and applying because synchronization is stable-only", async () => {
  const f = fixture();
  await expect(checkUpstream(["--main"], { api: f.api, actions: false })).rejects.toThrow();
  await expect(checkUpstream(["--main", "--apply"], { api: f.api, actions: false })).rejects.toThrow();
  expect(f.requests).toEqual([]);
});

test("moved pinned tags and malformed upstream commits require manual review", async () => {
  await expect(discoverUpstream(pin, fixture([], nextSha).api)).rejects.toThrow("Pinned upstream tag moved");
  await expect(discoverUpstream(pin, fixture([], "main").api)).rejects.toThrow("Invalid upstream SHA");
});

test("a new tag at the same commit still updates the pinned release name", async () => {
  expect((await discoverUpstream(pin, fixture(undefined, pin.sha).api)).changed).toBe(true);
});

test("checking is read-only for upstream.lock; applying and repeating synchronization are explicit", async () => {
  const w = await workspace(), f = fixture();
  try {
    const options = { directory: w.directory, api: f.api, actions: false };
    expect((await checkUpstream([], options)).applied).toBe(false);
    expect(await Bun.file(w.path).text()).toBe(w.original);
    expect((await checkUpstream(["--apply"], options)).applied).toBe(true);
    expect(await Bun.file(w.path).json()).toEqual({ ...pin, release: "v1.3.0", sha: nextSha });
    expect((await checkUpstream(["--apply"], options)).applied).toBe(false);
    expect((await Bun.file(join(w.directory, ".work/candidate.json")).json()).changed).toBe(false);
  } finally { await w.cleanup(); }
});

test("a concurrent manual edit of the pin is preserved instead of overwritten", async () => {
  const w = await workspace(), f = fixture();
  const edited = JSON.stringify({ ...pin, release: "v1.2.4" });
  try {
    const api = async (path: string) => { await Bun.write(w.path, edited); return f.api(path); };
    await expect(checkUpstream(["--apply"], { directory: w.directory, api, actions: false })).rejects.toThrow("changed during discovery");
    expect(await Bun.file(w.path).text()).toBe(edited);
  } finally { await w.cleanup(); }
});

test("Actions cannot apply upstream updates and unknown flags are rejected", async () => {
  const f = fixture();
  await expect(checkUpstream(["--apply"], { api: f.api, actions: true })).rejects.toThrow("local-only");
  await expect(checkUpstream(["--force-test"], { api: f.api })).rejects.toThrow();
  expect(f.requests).toEqual([]);
});

test("a GitHub API failure fails synchronization without changing the pin", async () => {
  const w = await workspace();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  try {
    await expect(checkUpstream(["--apply"], { directory: w.directory, api: githubApi(server.url.origin, ""), actions: false }))
      .rejects.toThrow("HTTP 503");
    expect(await Bun.file(w.path).text()).toBe(w.original);
  } finally { server.stop(true); await w.cleanup(); }
});
