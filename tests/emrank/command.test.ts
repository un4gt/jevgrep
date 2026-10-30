import { expect, test } from "bun:test";
import { command, sandbox } from "../helpers";

test("emrank command reports signed-out state without changing original commands", async () => {
  const box = await sandbox();
  try {
    const result = await command(["emrank", "--status"], box.env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).authenticated).toBe(false);
    const literal = await command(["emrank"], box.env);
    expect(literal.code).toBe(1);
    expect(literal.stdout).toContain("jg auth");
  } finally { await box.cleanup(); }
});
