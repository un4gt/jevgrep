import { expect, test } from "bun:test";
import { join } from "node:path";
import { connect } from "node:net";
import { command, sandbox, spawn, nativeCommand } from "../helpers";
import { pathToFileURL } from "node:url";
import { oauthServer } from "./server";

// Tokens at the fixture's 30-second refresh threshold are immediately eligible.
const refreshableLifetimeSeconds = 30;

async function login(env: Record<string, string | undefined>, spoof = false, callbackStatus = 200) {
  const p = spawn(["emrank", "--login"], env);
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
        expect((await fetch(url)).status).toBe(callbackStatus);
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
    expect(signedIn.stdout).toEndWith("Hello alice\n");
    expect(signedIn.stdout).not.toMatch(/accountId|cacheNamespace|expiresAt|authenticated|Model selected/);
    expect(signedIn.stdout).not.toContain("access-");
    const first = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    const records = [...new Bun.Glob("**/session").scanSync({ cwd: env.EMRANK_HOME, absolute: true })];
    expect(records).toHaveLength(1);
    expect(await Bun.file(records[0]!).text()).not.toContain("access-");
    const otherSite = { ...env, EMRANK_ISSUER: "http://127.0.0.1:1" };
    expect(JSON.parse((await command(["emrank", "--status"], otherSite)).stdout))
      .toMatchObject({ issuer: otherSite.EMRANK_ISSUER, authenticated: false });
    expect((await command(["emrank", "--logout"], otherSite)).code).toBe(0);
    expect(server.state.revoked).toBe(false);
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

test("login greeting never falls back to identifiers or prints unsafe or reflected usernames", async () => {
  for (const mode of ["missing", "echo", "control", "bidi", "long"]) {
    const box = await sandbox(), server = oauthServer();
    const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev" };
    try {
      server.state.usernameMode = mode;
      const result = await login(env);
      expect(result.code).toBe(0);
      expect(result.stdout).toEndWith("Hello\n");
      expect(result.stdout + result.stderr).not.toMatch(/account-a|accountId|cacheNamespace|expiresAt|authenticated|access-|refresh-|\u001b|\u202e/);
      const status = JSON.parse((await command(["emrank", "--status"], env)).stdout);
      expect(status.authenticated).toBe(true);
      expect(status.username).toBeUndefined();
      const selected = await command(["emrank", "--model", "fixture/other"], env);
      expect(selected.stdout).toBe("Model selected: fixture/other\n");
      expect(server.state.requests).toBe(0);
    } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
  }
});

test("refresh is serialized across CLI processes, invalid_grant clears credentials", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    expect((await command(["auth", "--provider", "custom", "--base-url", `${server.origin}/v1`, "--model", "original", "--stdin"], env, "original-fixture-key\n")).code).toBe(0);
    server.state.expiresIn = refreshableLifetimeSeconds;
    expect((await login(env)).code).toBe(0);
    const refreshesAfterLogin = server.state.refreshes;
    server.state.expiresIn = 3600;
    server.state.usernameMode = "renamed";
    const results = await Promise.all([command(["doctor"], env), command(["doctor"], env), command(["doctor"], env)]);
    expect(results.map(r => r.code)).toEqual([0, 0, 0]);
    expect(server.state.refreshes - refreshesAfterLogin).toBe(1);
    const refreshed = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect(refreshed.username).toBe("alice-renamed");
    expect(refreshed.accountId).toBe("account-a");
    server.state.expiresIn = refreshableLifetimeSeconds;
    expect((await login(env)).code).toBe(0);
    server.state.invalidGrant = true;
    const rejected = await command(["Where are events recorded?", box.source, "--no-cache"], env);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toContain("jg emrank --login");
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
    const result = await command(["emrank", "--login"], env);
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

test("ambiguous callbacks and unsupported authentication or mandatory PAR never reach token exchange", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    for (const mode of ["duplicate:state", "duplicate:iss", "duplicate:code", "code-and-error", "wrong-issuer"]) {
      server.state.callbackMode = mode;
      expect((await login(env, false, 400)).code).not.toBe(0);
      expect(server.state.tokenRequests).toBe(0);
    }
    server.state.callbackMode = "duplicate:error"; server.state.deny = true;
    expect((await login(env, false, 400)).code).not.toBe(0);
    expect(server.state.tokenRequests).toBe(0);
    server.state.deny = false; server.state.callbackMode = "";
    const authorized = server.state.authorizations;
    for (const metadata of [
      { require_pushed_authorization_requests: true },
      { token_endpoint_auth_methods_supported: ["attest_jwt_client_auth_dpop"] },
      { revocation_endpoint_auth_methods_supported: ["private_key_jwt"] },
    ]) {
      server.state.metadata = metadata;
      const result = await command(["emrank", "--login"], env);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("unsupported");
      expect(server.state.authorizations).toBe(authorized);
    }
  } finally { server.stop(); await box.cleanup(); }
});

test("refresh refuses an unchanged refresh token and preserves provider selection after clearing secrets", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    server.state.expiresIn = refreshableLifetimeSeconds;
    expect((await login(env)).code).toBe(0);
    const refreshesAfterLogin = server.state.refreshes;
    server.state.nonRotatingRefresh = true;
    const result = await command(["doctor"], env);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("--login");
    const status = JSON.parse((await command(["emrank", "--status"], env)).stdout);
    expect(status.requiresLogin).toBe(true);
    expect(status.authenticated).toBe(false);
    expect((await command(["doctor"], env)).code).not.toBe(0);
    expect(server.state.refreshes - refreshesAfterLogin).toBe(1);
    expect(server.state.resourceAttempts).toBe(0);
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});

test("CLI resource transport stays native and offline logout reports unconfirmed revocation", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    expect((await login(env)).code).toBe(0);
    const preload = join(box.dir, "no-fetch.mjs");
    await Bun.write(preload, "globalThis.fetch = () => { throw new Error('JS fetch intercepted'); };\n");
    const result = await command(["doctor"], { ...env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    expect(result.code).toBe(0);
    expect(server.state.requests).toBe(1);
    server.stop();
    const logout = await command(["emrank", "--logout"], env);
    expect(logout.code).toBe(0);
    expect(JSON.parse(logout.stdout)).toEqual({ localCleared: true, remoteRevoked: false });
    expect(logout.stderr).toContain("Remote revocation was not confirmed");
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(false);
  } finally { server.stop(); await box.cleanup(); }
});

test("native evaluations limit capabilities, snapshot bytes, sanitize successful responses and retry only the nonce challenge", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    server.state.resourceMode = "echo"; server.state.revokeNonce = true;
    const result = await nativeCommand("request", env);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("access-");
    expect(result.stdout).not.toContain("DPoP ");
    const output = JSON.parse(result.stdout);
    expect(output.error).toBeUndefined();
    expect(output.exported).not.toContain("authorizeRequest");
    expect(output.exported).not.toContain("acceptNonce");
    expect(output.result.status).toBe(200);
    expect(JSON.parse(output.result.body)).toEqual({ model: "fixture/jev", answers: { q0: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 12, output_tokens: 1 } });
    expect(output.repeated).toContain("unknown evaluation");
    expect(server.state.resourceAttempts).toBe(2);
    expect(server.state.requests).toBe(1);
    expect(server.state.resourceBodies[0]).toBe(server.state.resourceBodies[1]);
    expect(server.state.resourceBodies[0]).not.toContain("modified after admission");
    expect(server.state.revokeChallenges).toBe(1);
    expect(server.state.revoked).toBe(true);
    const proofs = server.state.proofs.filter(proof => proof.htu.endsWith("/systemone"));
    expect(proofs[0].jti).not.toBe(proofs[1].jti);
    expect(server.state.errors).toEqual([]);
  } finally { server.stop(); await box.cleanup(); }
});

test("native evaluations reject invalid inputs, stale sessions and cancellation before sending", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    const invalid = await nativeCommand("invalid", env);
    expect(invalid.code).toBe(0);
    const errors = JSON.parse(invalid.stdout).errors;
    expect(errors).toHaveLength(10);
    expect(errors.every((error: unknown) => typeof error === "string")).toBe(true);
    const cancelled = await nativeCommand("cancel-before", env);
    expect(cancelled.code).toBe(0);
    expect(JSON.parse(cancelled.stdout).error).toContain("cancelled");
    expect(server.state.resourceAttempts).toBe(0);
  } finally { server.stop(); await box.cleanup(); }
});

test("loopback callback accepts fragmented HTTP headers on both platforms", async () => {
  const box = await sandbox(), server = oauthServer();
  try {
    const result = await nativeCommand("fragmented-login", { ...box.env, EMRANK_ISSUER: server.origin,
      EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).result.status).toBe(200);
    expect(server.state.requests).toBe(1);
    expect(server.state.errors).toEqual([]);
  } finally { server.stop(); await box.cleanup(); }
});

for (const mode of ["cancel", "timeout"]) test(`native ${mode} interrupts a real pending HTTP response without resending inference`, async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    server.state.resourceDelayMs = 5000;
    const result = await nativeCommand(mode, env);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.error).toContain(mode === "cancel" ? "cancelled" : "timed out");
    expect(output.elapsedMs).toBeLessThan(2500);
    expect(server.state.requests).toBe(1);
    expect(server.state.resourceAttempts).toBe(2);
  } finally { server.stop(); await box.cleanup(); }
});

for (const mode of ["oversized", "malformed", "out-of-range"]) test(`native transport rejects ${mode} successful responses without exposing their bodies`, async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    server.state.resourceMode = mode;
    const result = await nativeCommand("request", env);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.error).toBeString();
    expect(output.result).toBeUndefined();
    expect(result.stdout).not.toContain("access-");
    expect(server.state.requests).toBe(1);
  } finally { server.stop(); await box.cleanup(); }
});

test("ordinary resource rejection retains its status without accepting a Bearer nonce challenge or echoing credentials", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    server.state.challengeScheme = "Bearer";
    let result = await nativeCommand("request", env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).result.status).toBe(401);
    expect(server.state.resourceAttempts).toBe(1);
    expect(server.state.requests).toBe(0);
    server.state.challengeScheme = "DPoP";
    for (const status of [403, 429, 503]) {
      server.state.resourceStatus = status;
      const before = server.state.requests;
      result = await nativeCommand("request", env);
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout).result;
      expect(output.status).toBe(status);
      expect(output.retryAfter).toBe("2");
      expect(result.stdout).not.toContain("access-");
      expect(server.state.requests - before).toBe(1);
    }
  } finally { server.stop(); await box.cleanup(); }
});

test("failed refresh contracts do not switch accounts or send inference, while transient OAuth errors retain local status", async () => {
  const box = await sandbox(), server = oauthServer();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    for (const mode of ["missing-refresh", "changed-account", "temporary-error"]) {
      server.state.expiresIn = refreshableLifetimeSeconds;
      server.state.omitRefresh = false; server.state.refreshAccount = ""; server.state.refreshError = "";
      expect((await login(env)).code).toBe(0);
      server.state.omitRefresh = mode === "missing-refresh";
      server.state.refreshAccount = mode === "changed-account" ? "another-account" : "";
      server.state.refreshError = mode === "temporary-error" ? "temporarily_unavailable" : "";
      const result = await command(["doctor"], env);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("never forward remote diagnostics");
      const status = JSON.parse((await command(["emrank", "--status"], env)).stdout);
      expect(status.accountId).toBe("account-a");
      if (mode === "temporary-error") expect(status.authenticated).toBe(true);
      expect(server.state.resourceAttempts).toBe(0);
    }
  } finally { await command(["emrank", "--logout"], env); server.stop(); await box.cleanup(); }
});
