import { expect, test } from "bun:test";
import { join } from "node:path";
import { connect } from "node:net";
import { command, sandbox, spawn } from "../helpers";
import { oauthServer } from "./server";

async function login(env: Record<string, string | undefined>, spoof = false) {
  const p = spawn(["emrank", "--login", "--no-browser"], env);
  let stdout = "", authorized = false;
  try {
    for await (const chunk of p.stdout) {
      stdout += new TextDecoder().decode(chunk);
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/)?.[0];
      if (url && !authorized) {
        authorized = true;
        if (spoof) {
          const callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
          callback.search = "?state=forged&code=forged";
          expect((await fetch(callback)).status).toBe(400);
        }
        expect((await fetch(url)).status).toBe(200);
      }
    }
    return { stdout, code: await p.exited, stderr: await new Response(p.stderr).text() };
  } finally { if (p.exitCode === null) { p.kill(); await p.exited; } }
}

test("real Node CLI logs in with PKCE and DPoP, searches, isolates accounts and restores saved provider", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    const auth = await command(["auth", "--provider", "custom", "--base-url", `${server.origin}/v1`, "--model", "original", "--stdin"], env, "original-fixture-key\n");
    expect(auth.code).toBe(0);
    const savedPath = join(box.dir, "config/jevgrep/credentials.json");
    const original = await Bun.file(savedPath).text();
    expect((await command(["doctor"], env)).code).toBe(0);
    expect(server.state.bearerCalls).toBe(1);
    const literalQuery = await command(["emrank", "--no-cache", box.source], env);
    expect(literalQuery.code).toBe(0);
    expect(literalQuery.stdout).toContain("recordEvent");
    const signedIn = await login(env, true);
    expect(signedIn.code).toBe(0);
    expect(signedIn.stdout).toContain('"accountId":"account-a"');
    expect(signedIn.stdout).not.toContain("access-");
    const first = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect((await Bun.file(join(env.EMRANK_HOME, "session")).text()).includes("access-")).toBe(false);
    const doctor = await command(["doctor"], env);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("connection verified");
    const search = await command(["Where are events recorded?", box.source], env);
    expect(search.code).toBe(0);
    expect(search.stdout).toContain("recordEvent");
    const before = server.state.requests;
    expect((await command(["Where are events recorded?", box.source], env)).code).toBe(0);
    expect(server.state.requests).toBe(before);
    expect(server.state.tokenChallenges).toBe(1);
    expect(server.state.resourceChallenges).toBe(1);
    server.state.account = "account-b";
    expect((await login(env)).code).toBe(0);
    const second = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect(second.accountId).toBe("account-b");
    expect(second.cacheNamespace).not.toBe(first.cacheNamespace);
    expect((await command(["Where are events recorded?", box.source], env)).code).toBe(0);
    expect(server.state.requests).toBeGreaterThan(before);
    expect((await command(["doctor"], { ...env, EMRANK_PROVIDER: "original" })).code).toBe(0);
    expect(await Bun.file(savedPath).text()).toBe(original);
    const logout = await command(["emrank", "--logout"], env);
    expect(logout.code).toBe(0);
    expect(JSON.parse(logout.stdout).remoteRevoked).toBe(true);
    expect(server.state.revoked).toBe(true);
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(false);
    expect((await command(["doctor"], env)).code).toBe(0);
    expect(server.state.errors).toEqual([]);
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});

export { login };

test("refresh is serialized across CLI processes, invalid_grant clears credentials", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    expect((await command(["auth", "--provider", "custom", "--base-url", `${server.origin}/v1`, "--model", "original", "--stdin"], env, "original-fixture-key\n")).code).toBe(0);
    server.state.expiresIn = 31;
    expect((await login(env)).code).toBe(0);
    await Bun.sleep(2100);
    server.state.expiresIn = 3600;
    const results = await Promise.all([command(["doctor"], env), command(["doctor"], env), command(["doctor"], env)]);
    expect(results.map(r => r.code)).toEqual([0, 0, 0]);
    expect(server.state.refreshes).toBe(1);
    server.state.expiresIn = 31;
    expect((await login(env)).code).toBe(0);
    await Bun.sleep(2100);
    server.state.invalidGrant = true;
    expect((await command(["doctor"], env)).code).not.toBe(0);
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(false);
    const repeated = await command(["doctor"], env);
    expect(repeated.code).not.toBe(0);
    expect(repeated.stdout).toContain("--login");
    expect(server.state.bearerCalls).toBe(0);
    expect(server.state.errors).toEqual([]);
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});

test("denial, Bearer downgrade, redirects and repeated nonce challenges fail closed without leaking tokens", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1", EMRANK_PROVIDER: "emrank" };
  try {
    server.state.deny = true;
    expect((await login(env)).code).not.toBe(0);
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(false);
    server.state.deny = false; server.state.tokenType = "Bearer";
    expect((await login(env)).code).not.toBe(0);
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(false);
    server.state.tokenType = "DPoP";
    expect((await login(env)).code).toBe(0);
    server.state.resourceStatus = 403;
    const rejected = await command(["doctor"], env);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stdout).toContain("403");
    expect(rejected.stdout).not.toContain("access-");
    expect(rejected.stderr).not.toContain("access-");
    server.state.resourceStatus = 200; server.state.redirectResource = true;
    expect((await command(["doctor"], env)).code).not.toBe(0);
    expect(server.state.errors).toEqual([]);
    server.state.redirectResource = false; server.state.nonceLoop = true;
    const before = server.state.resourceChallenges;
    expect((await command(["doctor"], env)).code).not.toBe(0);
    expect(server.state.resourceChallenges - before).toBe(2);
    expect(server.state.errors).toEqual([]);
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});

test("login timeout releases the callback and does not persist credentials", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1", EMRANK_LOGIN_TIMEOUT_SECONDS: "1" };
  try {
    const result = await command(["emrank", "--login", "--no-browser"], env);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("timed out");
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(false);
    const url = result.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/)![0];
    const callback = new URL(url).searchParams.get("redirect_uri")!;
    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: Number(new URL(callback).port) });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); error.code === "ECONNREFUSED" ? resolve(true) : reject(error); });
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("callback port check timed out")); });
    });
    expect(closed).toBe(true);
  } finally { server.stop(); await box.cleanup(); }
});
