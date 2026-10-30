import { resolve } from "node:path";
import { root, run, output, lock } from "../common";
import { updateBranch } from "./state";
const pin = await lock();
const sha = process.env.UPSTREAM_SHA!, release = process.env.UPSTREAM_RELEASE!;
if (!/^[a-f0-9]{40}$/.test(sha) || !/^v\d+\.\d+\.\d+$/.test(release)) throw new Error("Invalid candidate");
const branch = updateBranch(release, sha);
const previous = await output(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "url"]);
if (JSON.parse(previous).length) { console.log("An update PR already exists for this candidate"); process.exit(0); }
if (await output(["git", "ls-remote", "--heads", "origin", `refs/heads/${branch}`])) {
  // Recover a prior successful push followed by a failed PR API request.
  await run(["git", "fetch", "origin", branch]);
  await run(["git", "checkout", "-b", branch, "FETCH_HEAD"]);
  if ((await lock()).sha !== sha) throw new Error("Existing update branch differs; manual review required");
} else {
  await run(["git", "checkout", "-b", branch]);
  await Bun.write(resolve(root, "upstream.lock"), JSON.stringify({ ...pin, sha, release }, null, 2) + "\n");
  await run(["git", "add", "upstream.lock"]);
  await run(["git", "-c", "user.name=EMRank Sync", "-c", "user.email=sync@emrank.invalid", "commit", "-m", `chore: track upstream ${release}`]);
  await run(["git", "push", "origin", branch]);
}
const verificationUrl = process.env.VERIFIED_RUN_URL || `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const body = `上游正式版本更新为 ${release}（${sha}）。\n\nWindows x64 / Linux x64 glibc 已通过 Patch 应用、Rust 原生构建、上游功能回归、OAuth/PKCE/DPoP 登录与刷新/退出、全新 tarball 安装测试。\n\n- [上游差异](https://github.com/dzhng/jevgrep/compare/${pin.sha}...${sha})\n- [测试报告及构建产物](${verificationUrl})\n\n真实网关 OAuth 联调仍须按需求文档独立验收。本 PR 需要维护者审查，不启用自动合并。\n`;
await Bun.write(resolve(root, ".work-pr-body.md"), body);
await run(["gh", "pr", "create", "--head", branch, "--title", `chore: update jevgrep to ${release}`, "--body-file", resolve(root, ".work-pr-body.md")]);
