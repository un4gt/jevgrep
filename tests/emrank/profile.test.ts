import { expect, test } from "bun:test";
import { nativeCommand, sandbox } from "../helpers";
import { oauthServer } from "./server";
import { profileMetadata } from "./profile-peer";

async function fixture(run: (server: ReturnType<typeof oauthServer>, invoke: (mode?: string) => Promise<any>) => Promise<void>) {
  const server = oauthServer(true), box = await sandbox();
  const env = { ...box.env, EMRANK_ISSUER: server.origin, EMRANK_MODEL: "fixture/jev", EMRANK_ALLOW_HTTP_LOOPBACK: "1" };
  try {
    await run(server, async (mode = "evaluate") => JSON.parse((await nativeCommand(mode, env)).stdout));
  } finally { server.stop(); await box.cleanup(); }
}

test("attested profile uses PAR, Node verifies raw Rust HTTP signatures and nonce retries preserve bytes", () => fixture(async (s, invoke) => {
  const out = await invoke();
  expect(out.error).toBeUndefined();
  expect(out.result.status).toBe(200);
  expect(s.state.parRequests).toBe(2);
  expect(s.state.parChallenges).toBe(1);
  expect(s.state.parCreated).toBe(1);
  expect(s.state.parBodies[0]).toBe(s.state.parBodies[1]);
  expect(s.state.browserQueries).toEqual([["client_id", "request_uri"]]);
  expect(s.state.tokenChallenges).toBe(0); // AS nonce acquired at PAR.
  expect(s.state.resourceChallenges).toBe(1);
  expect(s.state.requests).toBe(1); // Challenge did not execute business.
  expect(s.state.resourceBodies[0]).toBe(s.state.resourceBodies[1]);
  expect(s.state.signatures.length).toBe(2);
  expect(s.state.signatures[0]).not.toBe(s.state.signatures[1]);
  expect(s.state.signatureInputs[0]).not.toBe(s.state.signatureInputs[1]);
  expect(s.state.attestations).toBe(1);
  expect(s.state.revoked).toBe(true);
  expect(s.state.errors).toEqual([]);
  expect(JSON.stringify(out)).not.toMatch(/access-|refresh-|oauth-client-attestation|sig1=/);
}));

test("unknown or mismatched security discovery fails before PAR, proof issuance or browser", async () => {
  for (const change of ["version", "spec", "integrity", "resource", "unknown", "method", "par", "origin"]) {
    await fixture(async (s, invoke) => {
      const m = profileMetadata(s.origin);
      const p = m.emrank_oauth.profiles[0]!;
      if (change === "version") p.contract_version = "2.0";
      if (change === "spec") p.client_authentication_spec = "draft-ietf-oauth-attestation-based-client-auth-11";
      if (change === "integrity") p.request_integrity_profile = "unknown";
      if (change === "resource") p.resource_endpoints[0]!.uri += "/changed";
      if (change === "unknown") Object.assign(p, { security_bypass: true });
      if (change === "method") m.token_endpoint_auth_methods_supported = ["none"];
      if (change === "par") m.require_pushed_authorization_requests = false;
      if (change === "origin") m.pushed_authorization_request_endpoint = "https://different.invalid/oauth/par";
      s.state.metadata = m;
      expect((await invoke("start-error")).error).toBeTruthy();
      expect(s.state.parRequests).toBe(0);
      expect(s.state.attestations).toBe(0);
      expect(s.state.authorizations).toBe(0);
    });
  }
});

test("fixture attestation verifies signature, instance binding and exact lifetime before PAR", async () => {
  for (const mode of ["bad-signature", "wrong-key", "wrong-client", "expired", "long-lived"]) {
    await fixture(async (s, invoke) => {
      s.state.attestationMode = mode;
      expect((await invoke("start-error")).error).toBeTruthy();
      expect(s.state.parRequests).toBe(0);
      expect(s.state.authorizations).toBe(0);
    });
  }
});

test("unregistered local application gives setup guidance without opening authorization or echoing the attester body", () => fixture(async (s, invoke) => {
  s.state.attestationMode = "unregistered";
  const out = await invoke("start-error");
  expect(out.error).toContain("HTTP 400");
  expect(out.error).toContain("client_id 'emrank-jevgrep'");
  expect(out.error).toContain(`${s.origin}/oauth`);
  expect(out.error).toContain("test-attested-dpop-v1");
  expect(out.error).not.toContain("untrusted-attester-body");
  expect(s.state.attestations).toBe(1);
  expect(s.state.parRequests).toBe(0);
  expect(s.state.authorizations).toBe(0);
  expect(s.state.tokenRequests).toBe(0);
  expect(s.state.requests).toBe(0);
}));

test("PAR rejects unsupported responses and limits nonce retries to a valid 400 challenge", async () => {
  for (const mode of ["nonce-loop", "missing-nonce", "wrong-nonce-status", "bad-status", "bad-expiry", "external-uri"]) {
    await fixture(async (s, invoke) => {
      s.state.parMode = mode;
      expect((await invoke("start-error")).error).toBeTruthy();
      expect(s.state.parRequests).toBe(["missing-nonce", "wrong-nonce-status"].includes(mode) ? 1 : 2);
      expect(s.state.authorizations).toBe(0);
      expect(s.state.tokenRequests).toBe(0);
      expect(s.state.errors).toEqual([]);
    });
  }
});

test("revoked instance/application stops subsequent calls; revoked grant erases credentials", async () => {
  for (const reason of ["instance_revoked", "application_disabled", "grant_revoked"]) {
    await fixture(async (s, invoke) => {
      s.state.resourceStatus = 401;
      s.state.resourceError = reason === "instance_revoked" ? "invalid_client_attestation" : "invalid_token";
      s.state.resourceReason = reason;
      const out = await invoke("profile-repeat");
      expect(out.result.status).toBe(401);
      expect(s.state.requests).toBe(1);
      expect(s.state.refreshes).toBe(0);
      expect(s.state.authorizations).toBe(1);
      if (reason === "grant_revoked") {
        expect(out.status.requiresLogin).toBe(true);
        expect(out.status.authenticated).toBe(false);
      } else expect(out.secondError).toContain("stopped");
      expect(JSON.stringify(out)).not.toMatch(/access-|refresh-/);
      expect(s.state.errors).toEqual([]);
    });
  }
});

test("fresh-attestation error is not retried; a later operation renews the same instance", () => fixture(async (s, invoke) => {
  s.state.resourceStatus = 401; s.state.resourceError = "use_fresh_attestation"; s.state.resourceReason = "attestation_expired";
  const out = await invoke("profile-repeat");
  expect(out.result.body).toContain("same instance key");
  expect(out.second.status).toBe(401);
  expect(s.state.requests).toBe(2);
  expect(s.state.attestations).toBeGreaterThanOrEqual(2);
  expect(s.state.refreshes).toBe(0);
  expect(s.state.authorizations).toBe(1);
  expect(s.state.errors).toEqual([]);
}));

test("ordinary, unknown and mismatched resource errors preserve session and never trigger refresh", async () => {
  for (const mode of ["ordinary", "unknown-reason", "missing-authenticate", "integrity", "scope", "security-limit", "dependency"]) {
    await fixture(async (s, invoke) => {
      s.state.resourceStatus = mode === "scope" ? 403 : mode === "security-limit" ? 429 : mode === "dependency" ? 503 : 401;
      s.state.resourceError = mode === "ordinary" ? "" : mode === "scope" ? "insufficient_scope"
        : mode === "security-limit" ? "emrank_security_rate_limited" : mode === "dependency" ? "emrank_temporarily_unavailable" : "invalid_token";
      s.state.resourceReason = mode === "unknown-reason" ? "attacker-controlled-reason"
        : mode === "missing-authenticate" ? "grant_revoked" : mode === "integrity" ? "request_integrity_failed" : mode === "scope" ? "scope_denied" : "";
      s.state.errorAuthenticate = mode !== "missing-authenticate";
      const out = await invoke("profile-repeat");
      expect(out.status.authenticated).toBe(true);
      expect(s.state.requests).toBe(2);
      expect(s.state.refreshes).toBe(0);
      expect(s.state.authorizations).toBe(1);
      expect(out.result.retryAfter).toBe("2");
      expect(JSON.stringify(out)).not.toMatch(/access-|refresh-|attacker-controlled-reason/);
      expect(s.state.errors).toEqual([]);
    });
  }
});
