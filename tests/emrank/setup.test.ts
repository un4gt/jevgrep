import { expect, test } from "bun:test";
import { command, sandbox, spawn } from "../helpers";
import { oauthServer } from "./server";

const fixtureTest = test.skipIf(process.env.EMRANK_TEST_EXPECT_FIXTURE !== "true");
type Environment = Record<string, string | undefined>;

async function signIn(env: Environment, model?: string) {
  const child = spawn(["emrank", "--login", ...(model ? ["--model", model] : [])], env);
  let stdout = "", opened = false;
  try {
    for await (const chunk of child.stdout) {
      stdout += new TextDecoder().decode(chunk);
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/)?.[0];
      if (url && !opened) { opened = true; expect((await fetch(url)).status).toBe(200); }
    }
    return { code: await child.exited, stdout };
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
}

fixtureTest("browser login needs no model; signed empty GET fetches choices and later selection persists without inference", async () => {
  const box = await sandbox(), server = oauthServer(true);
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: undefined, EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    const login = await signIn(env);
    expect(login.code).toBe(1); // Non-TTY cannot choose on behalf of the user.
    expect(login.stdout).toContain("Hello alice");
    expect(login.stdout).toContain("jg emrank --model");
    expect(login.stdout).not.toContain("fixture/embed");
    const pending = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect(pending.authenticated).toBe(true);
    expect(pending.requiresModelSelection).toBe(true);
    expect(pending.model).toBeUndefined();
    expect(server.state.catalogChallenges).toBe(1);
    expect(server.state.catalogSignatures).toHaveLength(2);
    expect(server.state.catalogSignatures[0]).not.toBe(server.state.catalogSignatures[1]);
    const getProofs = server.state.proofs.filter(proof => proof.htm === "GET");
    expect(getProofs).toHaveLength(2);
    expect(getProofs[0].jti).not.toBe(getProofs[1].jti);
    const blocked = await command(["doctor"], env);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toContain("choose a model");
    const selection = await command(["emrank", "--model", "fixture/jev"], env);
    expect(selection.code).toBe(0);
    const selected = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect(selected.model).toBe("fixture/jev");
    expect(selected.requiresModelSelection).toBe(false);
    expect(selected.cacheNamespace).not.toBe(pending.cacheNamespace);
    expect((await command(["emrank", "--model", "fixture/other"], env)).code).toBe(0);
    const changed = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect(changed.model).toBe("fixture/other");
    expect(changed.cacheNamespace).not.toBe(selected.cacheNamespace);
    expect(server.state.requests).toBe(0);
    expect(server.state.resourceAttempts).toBe(0);
    expect(server.state.errors).toEqual([]);
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});

fixtureTest("empty or changed application allowlists never choose a fallback or erase a valid login", async () => {
  const box = await sandbox(), server = oauthServer(true);
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: undefined, EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    server.state.models = [];
    const login = await signIn(env);
    expect(login.stdout).toContain("no available decision models");
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(true);
    server.state.models = [{ id: "fixture/jev", kind: "decision" }, { id: "fixture/embed", kind: "embedding" }];
    const forbidden = await command(["emrank", "--model", "fixture/embed"], env);
    expect(forbidden.code).toBe(1);
    expect(forbidden.stdout).toContain("not available to this application");
    expect((await command(["emrank", "--model", "fixture/jev"], env)).code).toBe(0);
    const before = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    server.state.models = [{ id: "fixture/other", kind: "decision" }];
    expect((await command(["emrank", "--model", "fixture/jev"], env)).code).toBe(1);
    const after = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect(after.authenticated).toBe(true);
    expect(after.model).toBe(before.model);
    expect(after.cacheNamespace).toBe(before.cacheNamespace);
    const rejected = await command(["doctor"], env);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toContain("jg emrank --model");
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(true);
    expect(server.state.refreshes).toBe(0);
    expect(server.state.requests).toBe(0);
    expect(server.state.errors).toEqual([]);
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});

fixtureTest("model catalog retries nonce once, refuses redirects and never releases echoed tokens", async () => {
  const box = await sandbox(), server = oauthServer(true);
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: undefined, EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    expect((await signIn(env, "fixture/jev")).code).toBe(0);
    for (const mode of ["nonce-loop", "redirect", "echo"]) {
      server.state.catalogMode = mode;
      const count = server.state.catalogRequests;
      const result = await command(["emrank", "--model"], env);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("access-");
      expect(server.state.catalogRequests - count).toBe(mode === "nonce-loop" ? 2 : 1);
      expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(true);
    }
    expect(server.state.requests).toBe(0);
    expect(server.state.errors).toEqual([]);
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});
