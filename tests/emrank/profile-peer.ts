import { createECDH, createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

// Independent Node crypto peer. Public synthetic root, same [1;32] scalar as
// the gateway vectors. This is never a platform attestation or production CA.
const secret = Buffer.alloc(32, 1), ec = createECDH("prime256v1");
ec.setPrivateKey(secret);
const point = ec.getPublicKey(undefined, "uncompressed");
const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
const privateKey = createPrivateKey({ key: { ...jwk, d: secret.toString("base64url") }, format: "jwk" });
const publicKey = createPublicKey({ key: jwk, format: "jwk" });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const hash = (v: string) => createHash("sha256").update(v).digest("base64url");

export function profileMetadata(origin: string) {
  return {
    pushed_authorization_request_endpoint: `${origin}/oauth/par`, require_pushed_authorization_requests: true,
    token_endpoint_auth_methods_supported: ["attest_jwt_client_auth_dpop"], revocation_endpoint_auth_methods_supported: ["attest_jwt_client_auth_dpop"],
    response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["inference:systemone", "offline_access"], client_attestation_signing_alg_values_supported: ["ES256"],
    client_attestation_pop_methods_supported: ["dpop_combined"],
    emrank_oauth: { manual_authorization: { version: "1", redirect_uri: "urn:emrank:oauth:manual", response_format: "emrank-manual-v1" }, profiles: [{ id: "attested-dpop-v1", contract_version: "1.0",
      client_authentication_spec: "draft-ietf-oauth-attestation-based-client-auth-12", resource: `${origin}/v1`,
      resource_endpoints: [{ method: "POST", uri: `${origin}/v1/systemone`, required_scope: "inference:systemone" },
        { method: "GET", uri: `${origin}/v1/models`, required_scope: "inference:systemone" }],
      request_integrity_profile: "oauth-resource-v1", error_profile: "emrank-oauth-errors-v1" }] },
  };
}

export function attestation(key: unknown, client: string, mode = "") {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://attester.example.test", sub: client, iat: now, exp: now + 300,
    cnf: { jwk: mode === "wrong-key" ? jwk : key }, "https://emrank.tech/oauth/client-policy": "native-test-policy-v1" };
  if (mode === "expired") { claims.iat = now - 300; claims.exp = now; }
  if (mode === "long-lived") claims.exp++;
  if (mode === "wrong-client") claims.sub = "another-client";
  const input = `${b64({ typ: "oauth-client-attestation+jwt", alg: "ES256", kid: "issuer-key-1" })}.${b64(claims)}`;
  const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
  if (mode === "bad-signature") signature[0] = signature[0]! ^ 1;
  return `${input}.${signature.toString("base64url")}`;
}

export function verifyAttestation(req: Request, jkt: string) {
  if (req.headers.has("oauth-client-attestation-pop")) throw new Error("extra combined-mode PoP");
  const raw = req.headers.get("oauth-client-attestation") ?? "";
  if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(raw)) throw new Error("attestation must be a bare SF token");
  const [h, c, s] = raw.split(".");
  if (!verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"))) throw new Error("untrusted attestation");
  const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
  const { crv, kty, x, y } = claims.cnf.jwk;
  if (hash(JSON.stringify({ crv, kty, x, y })) !== jkt || claims.sub !== "emrank-jevgrep" || claims.exp <= Date.now()/1000) throw new Error("attestation key/client/expiry mismatch");
}

export function verifyIntegrity(req: Request, body: string, claims: any, jkt: string, key: any) {
  if (req.headers.get("content-type") !== "application/json" || req.headers.has("content-encoding")) throw new Error("wrong content encoding");
  const digest = `sha-256=:${createHash("sha256").update(Buffer.from(body)).digest("base64")}:`;
  if (req.headers.get("content-digest") !== digest) throw new Error("body digest mismatch");
  const input = req.headers.get("signature-input") ?? "";
  const match = input.match(/^sig1=\("@method" "@target-uri" "content-type" "content-digest" "dpop"\);created=(\d+);expires=(\d+);nonce="([A-Za-z0-9_-]+)";alg="ecdsa-p256-sha256";keyid="([A-Za-z0-9_-]+)";tag="oauth-resource-v1"$/);
  if (!match) throw new Error("noncanonical signature input");
  const [, created, expires, nonce, keyid] = match;
  const now = Math.floor(Date.now()/1000);
  if (+created! > now+5 || now > +created!+60 || +expires! <= +created! || +expires! > +created!+60 || now >= +expires! || nonce !== claims.jti || keyid !== jkt) throw new Error("signature binding/time mismatch");
  const encoded = req.headers.get("signature")?.match(/^sig1=:([A-Za-z0-9+/]+={0,2}):$/)?.[1];
  if (!encoded) throw new Error("missing signature");
  const signature = Buffer.from(encoded, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== encoded) throw new Error("signature must be canonical padded P1363");
  const lines = [`"@method": ${req.method}`, `"@target-uri": ${req.url}`, '"content-type": application/json',
    `"content-digest": ${digest}`, `"dpop": ${req.headers.get("dpop")}`, `"@signature-params": ${input.slice(5)}`];
  if (!verify("sha256", Buffer.from(lines.join("\n")), { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature)) throw new Error("invalid HTTP signature");
}
