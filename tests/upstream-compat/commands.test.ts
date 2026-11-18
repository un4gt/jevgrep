import { expect, test } from "bun:test";
import { command, sandbox } from "../helpers";

test("built Node CLI preserves help, version, inventory policy, auth validation and cache clear", async () => {
  const box = await sandbox();
  try {
    const help = await command(["--help"], box.env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("jg");
    expect(help.stdout).toMatch(/--concurrency N[^\n]*\(default: 4\)/);
    expect((await command(["--version"], box.env)).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const files = await command(["files", box.source, "--list"], box.env);
    expect(files.code).toBe(0);
    expect(files.stdout).toContain("events.ts");
    expect(files.stdout).toContain("No provider requests");
    const excluded = await command(["files", box.source, "--list", "--exclude", "*.ts"], box.env);
    expect(excluded.code).toBe(0);
    expect(excluded.stdout).not.toContain('"events.ts"');
    const auth = await command(["auth", "--provider", "openrouter", "--stdin"], box.env, "fixture-original-key\n");
    expect(auth.code).toBe(0);
    expect(auth.stdout).toContain("saved");
    expect((await command(["auth", "--provider", "no-such-provider", "--stdin"], box.env, "fixture\n")).code).not.toBe(0);
    expect((await command(["cache", "clear"], box.env)).stdout).toContain("Cache cleared");
    expect((await command(["emrank", "--invalid"], box.env)).code).not.toBe(0);
    expect((await command(["skill", "--provider", "custom"], box.env)).code).not.toBe(0);
    const invalid = await command(["query", box.source, "--concurrency", "0"], box.env);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain("--concurrency must be a positive integer");
  } finally { await box.cleanup(); }
});

// A provider error includes the concurrency of the evaluator that actually sent the request.
// This checks CLI wiring without relying on delays or scheduler timing in CI.
test("search uses the fork default and accepts smaller and larger concurrency overrides", async () => {
  const box = await sandbox();
  const env = { ...box.env, EMRANK_PROVIDER: "original" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: { message: "Local test rejection" } }, { status: 400 }),
  });
  try {
    const auth = await command(
      ["auth", "--provider", "custom", "--base-url", `${server.url.origin}/v1`, "--model", "test/local", "--stdin"],
      env,
      "test-key\n",
    );
    expect(auth.code).toBe(0);
    for (const setting of [undefined, 2, 6]) {
      const flags = setting === undefined ? [] : ["--concurrency", String(setting)];
      const result = await command(["Where are events recorded?", box.source, "--no-cache", ...flags], env);
      expect(result.code).toBe(2);
      expect(result.stdout).toContain(`max concurrent requests: ${setting ?? 4})`);
    }
  } finally {
    server.stop(true);
    await box.cleanup();
  }
});
