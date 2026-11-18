import { expect, test } from "bun:test";
import { command, sandbox } from "../helpers";

test.skipIf(process.env.EMRANK_TEST_EXPECT_FIXTURE === "true")("unavailable sign-in explains the release limitation before requesting configuration", async () => {
  const box = await sandbox();
  try {
    const result = await command(["emrank", "--login"], { ...box.env, EMRANK_ISSUER: undefined, EMRANK_MODEL: undefined });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("no registered release build");

    expect(result.stdout).not.toContain("set EMRANK_ISSUER");
    expect(await Bun.file(`${box.env.EMRANK_HOME}/emrank-login.json`).exists()).toBe(false);
  } finally { await box.cleanup(); }
});

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
