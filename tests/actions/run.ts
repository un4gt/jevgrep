import { root, run } from "../../scripts/common";

// Docker Desktop must be using Linux containers. act and its artifact server run
// inside Linux as well; only this small launcher runs on the developer's OS.
const image = "emrank-jg-act:local";
if (!process.argv.includes("--skip-build"))
  await run(["docker", "build", "-t", image, "-f", "tests/actions/Dockerfile", "tests/actions"]);
await run(["docker", "run", "--rm", "--network", "host",
  "--mount", `type=bind,source=${root},target=/workspace`,
  "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
  "--mount", "type=volume,source=emrank-jg-act-cache,target=/root/.cache",
  "-w", "/workspace", image, "bun", "tests/actions/suite.ts",
  ...process.argv.filter(arg => arg.startsWith("--case=") || arg === "--verbose"),
  ...(process.argv.includes("--quick") ? [] : ["--full"])], root, {}, 60 * 60_000);
