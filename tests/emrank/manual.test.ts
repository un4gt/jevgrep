import { expect, test } from "bun:test";
import { cli, command, nativeCommand, sandbox } from "../helpers";
import { oauthServer } from "./server";
import { profileMetadata } from "./profile-peer";

test("manual native login binds the pasted code to issuer, state, PKCE and key; cancellation, expiry and replay fail closed", async () => {
  for (const mode of ["success", "wrong-state", "wrong-issuer", "extra", "code-and-error", "duplicate", "padding", "url", "oversized", "cancel", "timeout", "other-attempt", "replay", "expired-code", "denied"]) {
    const box = await sandbox(), server = oauthServer(true);
    try {
      server.state.expireCode = mode === "expired-code";
      server.state.deny = mode === "denied";
      const env = { ...box.env, EMRANK_ISSUER: server.origin, ...(mode === "timeout" ? { EMRANK_LOGIN_TIMEOUT_SECONDS: "1" } : {}) };
      const out = JSON.parse((await nativeCommand(`manual-${mode}`, env)).stdout);
      expect(out.status.authenticated).toBe(mode === "success");
      if (mode === "success") {
        expect(out.result.requiresModelSelection).toBe(true);
        expect(out.error).toBeUndefined();
      } else expect(out.error).toBeTruthy();
      expect(out.repeated).toContain("unknown login attempt");
      const exchangeModes = ["success", "other-attempt", "replay", "expired-code"];
      if (!exchangeModes.includes(mode)) expect(server.state.tokenRequests).toBe(0);
      expect(server.state.requests).toBe(0);
      expect(server.state.catalogRequests).toBe(0);
      expect(server.state.parBodies.every(body => new URLSearchParams(body).get("redirect_uri") === "urn:emrank:oauth:manual")).toBe(true);
      expect(server.state.browserQueries.every(keys => keys.join() === "client_id,request_uri")).toBe(true);
      expect(JSON.stringify(out)).not.toMatch(/emrank1\.|access-|refresh-/);
    } finally { server.stop(); await box.cleanup(); }
  }
});

test("manual login requires an advertised exact extension and explicit application registration", async () => {
  for (const mode of ["missing", "unknown-version", "unknown-field", "wrong-redirect", "unregistered"]) {
    const box = await sandbox(), server = oauthServer(true);
    try {
      const metadata = profileMetadata(server.origin);
      if (mode === "missing") delete (metadata.emrank_oauth as any).manual_authorization;
      if (mode === "unknown-version") metadata.emrank_oauth.manual_authorization.version = "2";
      if (mode === "unknown-field") Object.assign(metadata.emrank_oauth.manual_authorization, { ignored: true });
      if (mode === "wrong-redirect") metadata.emrank_oauth.manual_authorization.redirect_uri = "https://wrong.invalid";
      if (mode === "unregistered") server.state.manualRegistered = false;
      server.state.metadata = metadata;
      const out = JSON.parse((await nativeCommand("manual-start-error", { ...box.env, EMRANK_ISSUER: server.origin })).stdout);
      expect(out.error).toBeTruthy();
      expect(out.status.authenticated).toBe(false);
      expect(server.state.authorizations).toBe(0);
      expect(server.state.tokenRequests).toBe(0);
      if (mode !== "unregistered") expect(server.state.parRequests).toBe(0);
    } finally { server.stop(); await box.cleanup(); }
  }
});

test("CLI manual login consumes a pasted code without echo, selects a model and rejects the removed flag", async () => {
  const box = await sandbox(), server = oauthServer(true);
  const env = { ...box.env, EMRANK_ISSUER: server.origin };
  const child = Bun.spawn(["node", cli, "emrank", "--login", "--manual", "--model", "fixture/other"], {
    env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  let stdout = "", pasted = "";
  try {
    for await (const chunk of child.stdout) {
      stdout += new TextDecoder().decode(chunk);
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/)?.[0];
      if (url && !pasted) {
        const response = await fetch(url);
        expect(response.headers.get("cache-control")).toBe("no-store");
        pasted = (await response.json() as { manual_code: string }).manual_code;
        child.stdin.write(pasted + "\n"); child.stdin.end();
      }
    }
    expect(await child.exited).toBe(0);
    const stderr = await new Response(child.stderr).text();
    expect(stdout).toEndWith("Hello alice\n");
    expect(stdout).not.toMatch(/accountId|cacheNamespace|expiresAt|authenticated|Model selected/);
    expect(stdout + stderr).not.toContain(pasted);
    expect(stdout + stderr).not.toMatch(/access-|refresh-/);
    expect(server.state.requests).toBe(0);
    expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).model).toBe("fixture/other");
    const removed = await command(["emrank", "--login", "--no-browser"], env);
    expect(removed.code).toBe(1);
    expect(removed.stdout).toContain("--manual");
    expect((await command(["emrank", "--logout"], env)).code).toBe(0);
    expect(server.state.errors).toEqual([]);
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    server.stop(); await box.cleanup();
  }
});

test("CLI manual prompt handles timeout, EOF and oversized input without token exchange", async () => {
  for (const input of [undefined, "", "a".repeat(4097) + "\n"]) {
    const box = await sandbox(), server = oauthServer(true);
    const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_LOGIN_TIMEOUT_SECONDS: "1" };
    const child = Bun.spawn(["node", cli, "emrank", "--login", "--manual"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    try {
      if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(stdout + stderr).not.toContain("aaaa");
      if (input === undefined) expect(stdout).toContain("timed out");
      expect(server.state.tokenRequests).toBe(0);
      expect(JSON.parse((await command(["emrank", "--status"], env)).stdout).authenticated).toBe(false);
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
      server.stop(); await box.cleanup();
    }
  }
});
