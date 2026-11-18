import { expect, test } from "bun:test";
import { nativeCommand, sandbox } from "../helpers";

test.skipIf(process.env.EMRANK_TEST_EXPECT_FIXTURE === "true")("production binaries keep the compiled issuer despite runtime HTTP overrides", async () => {
  const box = await sandbox();
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({}); } });
  try {
    const result = await nativeCommand("production", { ...box.env, EMRANK_ISSUER: `http://127.0.0.1:${server.port}`,
      EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" });
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.testBuild).toBe(false);
    expect(output.error).toContain("no registered release build");
    expect(output.manualError).toContain("no registered release build");
    expect(output.issuer).toBe("https://emrank.tech");
    expect(output.exported).not.toContain("authorizeRequest");
    expect(output.exported).not.toContain("acceptNonce");
    expect(requests).toBe(0);
  } finally { server.stop(true); await box.cleanup(); }
});

test.skipIf(process.env.EMRANK_TEST_EXPECT_FIXTURE === "true")("unprovisioned HTTPS production profile fails before network or browser even with fixture environment flags", async () => {
  const box = await sandbox();
  try {
    const result = await nativeCommand("production", { ...box.env, EMRANK_ISSUER: "https://unprovisioned.invalid",
      EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" });
    const output = JSON.parse(result.stdout);
    expect(output.error).toContain("no registered release build");
    expect(output.manualError).toContain("no registered release build");
    expect(output.exported).not.toContain("authorizeRequest");
    expect(output.exported).not.toContain("sign");
  } finally { await box.cleanup(); }
});
