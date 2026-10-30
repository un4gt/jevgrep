import { expect, test } from "bun:test";
import { command, sandbox } from "../helpers";

test("built Node CLI preserves help, version, inventory policy, auth validation and cache clear", async () => {
  const box = await sandbox();
  try {
    const help = await command(["--help"], box.env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("jg");
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
    expect((await command(["query", box.source, "--concurrency", "0"], box.env)).code).not.toBe(0);
  } finally { await box.cleanup(); }
});
