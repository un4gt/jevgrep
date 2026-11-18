import { createHash, createPublicKey, randomBytes, randomInt, verify } from "node:crypto";
import { attestation, profileMetadata, verifyAttestation, verifyIntegrity } from "./profile-peer";
const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
const json = (body: unknown, status = 200, headers = {}) => Response.json(body, { status, headers });

function browserSafeServer(fetch: (request: Request) => Promise<Response>) {
  // This machine's customized ephemeral range includes Fetch-blocked ports.
  // Bind directly (no probe/rebind race) in the browser-safe private range.
  for (let attempt = 0; attempt < 128; attempt++) {
    try { return Bun.serve({ hostname: "127.0.0.1", port: randomInt(49152, 65536), fetch }); }
    catch (error) {
      if (!(error instanceof Error) || !["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("No browser-safe loopback port available for the OAuth peer");
}

// A protocol peer, not a replacement native client: independently checks ES256,
// PKCE, proof replay, htm/htu/ath, code/key binding, rotation and revocation.
export function oauthServer(attested = false) {
  const pars = new Map<string, URLSearchParams>();
  const codes = new Map<string, { challenge: string; redirect: string; jkt: string; account: string; expires: number }>();
  const access = new Map<string, { jkt: string; account: string }>();
  const refresh = new Map<string, { jkt: string; account: string }>();
  const seen = new Set<string>();
  const state = { account: "account-a", tokenType: "DPoP", expiresIn: 3600, refreshes: 0, requests: 0,
    tokenChallenges: 0, resourceChallenges: 0, revoked: false, deny: false, invalidGrant: false,
    parRequests: 0, parChallenges: 0, parCreated: 0, parMode: "", parBodies: [] as string[], browserQueries: [] as string[][],
    attestations: 0, attestationMode: "", resourceError: "", resourceReason: "", errorAuthenticate: true,
    manualRegistered: true, expireCode: false, usernameMode: "",
    signatures: [] as string[], signatureInputs: [] as string[],
    models: [{ id: "fixture/jev", kind: "decision" }, { id: "fixture/other", kind: "decision" }, { id: "fixture/embed", kind: "embedding" }],
    catalogRequests: 0, catalogChallenges: 0, catalogMode: "", catalogSignatures: [] as string[],
    metadata: {} as Record<string, unknown>, callbackMode: "", authorizations: 0, tokenRequests: 0,
    nonRotatingRefresh: false, omitRefresh: false, refreshAccount: "", refreshError: "",
    revokeNonce: false, revokeChallenges: 0, resourceDelayMs: 0, resourceMode: "", resourceAttempts: 0,
    challengeScheme: "DPoP", resourceBodies: [] as string[], receivedHeaders: [] as string[][],
    resourceStatus: 200, redirectResource: false, nonceLoop: false, proofs: [] as any[], errors: [] as string[], bearerCalls: 0 };
  let origin = "";
  function proof(req: Request, token?: string) {
    const encoded = req.headers.get("dpop") ?? "";
    const parts = encoded.split(".");
    if (parts.length !== 3) throw new Error("missing proof");
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || header.jwk.d) throw new Error("bad proof header");
    const key = createPublicKey({ key: header.jwk, format: "jwk" });
    if (!verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"))) throw new Error("bad signature");
    const url = new URL(req.url); url.search = ""; url.hash = "";
    if (claims.htm !== req.method || claims.htu !== url.href || Math.abs(Date.now()/1000 - claims.iat) > 10 || !claims.jti || seen.has(claims.jti)) throw new Error("bad or replayed proof claims");
    if (token && claims.ath !== hash(token)) throw new Error("bad ath");
    if (!token && claims.ath !== undefined) throw new Error("ath on token request");
    seen.add(claims.jti); state.proofs.push(claims);
    const { crv, kty, x, y } = header.jwk;
    const jkt = hash(JSON.stringify({ crv, kty, x, y }));
    if (attested) verifyAttestation(req, jkt);
    return { claims, jkt, jwk: header.jwk };
  }
  const server = browserSafeServer(async req => {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, revocation_endpoint: `${origin}/oauth/revoke`,
        token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"], dpop_signing_alg_values_supported: ["ES256"], authorization_response_iss_parameter_supported: true,
        ...(attested ? profileMetadata(origin) : {}),
        ...state.metadata });
      if (attested && url.pathname === "/__fixture/attestation") {
        const body = await req.json() as { jwk: unknown; client_id: string };
        state.attestations++;
        if (state.attestationMode === "unregistered")
          return json({ error: "invalid_request", emrank_reason: "malformed_request", error_description: "untrusted-attester-body" }, 400);
        return json({ attestation: attestation(body.jwk, body.client_id, state.attestationMode) });
      }
      if (attested && url.pathname === "/oauth/par") {
        state.parRequests++;
        const { claims, jkt } = proof(req);
        const raw = await req.text(); state.parBodies.push(raw);
        const q = new URLSearchParams(raw);
        if (q.get("redirect_uri") === "urn:emrank:oauth:manual" && !state.manualRegistered)
          return json({ error: "invalid_request" }, 400);
        const fields = ["response_type", "client_id", "redirect_uri", "scope", "resource", "state", "code_challenge", "code_challenge_method", "dpop_jkt"];
        if (raw.length > 16384 || [...q.keys()].length !== 9 || fields.some(k => q.getAll(k).length !== 1) || q.get("dpop_jkt") !== jkt) throw new Error("PAR form/key mismatch");
        if (claims.nonce !== "as-nonce" || state.parMode === "nonce-loop") {
          state.parChallenges++;
          return json({ error: "use_dpop_nonce" }, state.parMode === "wrong-nonce-status" ? 401 : 400,
            state.parMode === "missing-nonce" ? {} : { "DPoP-Nonce": "as-nonce" });
        }
        const handle = `urn:ietf:params:oauth:request_uri:${crypto.randomUUID()}`;
        pars.set(handle, q); state.parCreated++;
        return json({ request_uri: state.parMode === "external-uri" ? `${origin}/evil` : handle, expires_in: state.parMode === "bad-expiry" ? 300 : 90 }, state.parMode === "bad-status" ? 200 : 201);
      }
      if (url.pathname === "/oauth/authorize") {
        state.authorizations++;
        state.browserQueries.push([...url.searchParams.keys()]);
        let q = url.searchParams;
        if (attested) {
          if ([...q.keys()].sort().join() !== "client_id,request_uri" || q.get("client_id") !== "emrank-jevgrep") throw new Error("authorization must only contain PAR handle and client");
          const pushed = pars.get(q.get("request_uri")!);
          if (!pushed) throw new Error("unknown or consumed PAR");
          pars.delete(q.get("request_uri")!); q = pushed;
        }
        if (q.get("code_challenge_method") !== "S256" || q.get("client_id") !== "emrank-jevgrep" || q.get("response_type") !== "code" || q.get("resource") !== `${origin}/v1`) throw new Error("invalid authorize request");
        const redirect = new URL(q.get("redirect_uri")!);
        const manual = attested && redirect.href === "urn:emrank:oauth:manual" && state.manualRegistered;
        if (!manual && (redirect.hostname !== "127.0.0.1" || redirect.protocol !== "http:" || redirect.pathname !== "/callback")) throw new Error("invalid callback");
        const code = randomBytes(32).toString("base64url");
        if (!state.deny) codes.set(code, { challenge: q.get("code_challenge")!, jkt: q.get("dpop_jkt")!, redirect: redirect.href, account: state.account, expires: Date.now() + (state.expireCode ? -1 : 60000) });
        if (manual) {
          const payload = { iss: origin, state: q.get("state")!, ...(state.deny ? { error: "access_denied" } : { code }) };
          return json({ manual_code: `emrank1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}` }, 200,
            { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        }
        redirect.searchParams.set("state", q.get("state")!);
        redirect.searchParams.set("iss", origin);
        redirect.searchParams.set(state.deny ? "error" : "code", state.deny ? "access_denied" : code);
        if (state.callbackMode.startsWith("duplicate:")) {
          const name = state.callbackMode.slice(10);
          redirect.searchParams.append(name, redirect.searchParams.get(name) ?? "duplicate");
        }
        if (state.callbackMode === "code-and-error") redirect.searchParams.set("error", "access_denied");
        if (state.callbackMode === "wrong-issuer") redirect.searchParams.set("iss", "https://wrong.invalid");
        return Response.redirect(redirect.href, 302);
      }
      if (url.pathname === "/oauth/token") {
        state.tokenRequests++;
        const { claims, jkt } = proof(req);
        if (claims.nonce !== "as-nonce") { state.tokenChallenges++; return json({ error: "use_dpop_nonce" }, 400, { "DPoP-Nonce": "as-nonce" }); }
        const form = new URLSearchParams(await req.text());
        if (form.get("client_id") !== "emrank-jevgrep" || form.get("resource") !== `${origin}/v1`) throw new Error("wrong client or resource");
        let account: string;
        if (form.get("grant_type") === "authorization_code") {
          const code = codes.get(form.get("code")!);
          if (!code || Date.now() >= code.expires) return json({ error: "invalid_grant" }, 400);
          if (!code || code.challenge !== hash(form.get("code_verifier")!) || code.redirect !== form.get("redirect_uri") || code.jkt !== jkt) throw new Error("PKCE, redirect or key binding failed");
          codes.delete(form.get("code")!); account = code.account;
        } else {
          state.refreshes++;
          if (state.refreshError) return json({ error: state.refreshError, error_description: "never forward remote diagnostics" }, 400);
          const grant = refresh.get(form.get("refresh_token")!);
          if (!grant || grant.jkt !== jkt || state.invalidGrant) return json({ error: "invalid_grant" }, 400);
          refresh.delete(form.get("refresh_token")!); account = grant.account;
        }
        const refreshing = form.get("grant_type") === "refresh_token";
        const at = `access-${crypto.randomUUID()}`, rt = refreshing && state.nonRotatingRefresh ? form.get("refresh_token")! : `refresh-${crypto.randomUUID()}`;
        access.set(at, { jkt, account }); refresh.set(rt, { jkt, account });
        const username = state.usernameMode === "echo" ? at : state.usernameMode === "control" ? "alice\u001b[2J"
          : state.usernameMode === "bidi" ? "alice\u202eevil" : state.usernameMode === "long" ? "x".repeat(257)
          : state.usernameMode === "renamed" ? "alice-renamed" : account === "account-b" ? "bob" : "alice";
        return json({ access_token: at, ...(state.omitRefresh ? {} : { refresh_token: rt }), token_type: state.tokenType,
          ...(state.usernameMode === "missing" ? {} : { username }),
          expires_in: state.expiresIn, account_id: refreshing && state.refreshAccount ? state.refreshAccount : account });
      }
      if (url.pathname === "/oauth/revoke") {
        const { jkt, claims } = proof(req);
        if (state.revokeNonce && claims.nonce !== "revoke-nonce") {
          state.revokeChallenges++;
          return json({ error: "use_dpop_nonce" }, 400, { "DPoP-Nonce": "revoke-nonce" });
        }
        const form = new URLSearchParams(await req.text());
        const grant = refresh.get(form.get("token")!);
        if (!grant || grant.jkt !== jkt) throw new Error("bad revocation");
        refresh.delete(form.get("token")!);
        for (const [token, value] of access) if (value.jkt === jkt) access.delete(token);
        state.revoked = true; return new Response(null, { status: 200 });
      }
      if (url.pathname === "/v1/models") {
        state.catalogRequests++;
        if (req.method !== "GET" || url.search || (await req.text()) !== "") throw new Error("invalid model catalog request");
        const authorization = req.headers.get("authorization") ?? "";
        if (!authorization.startsWith("DPoP ")) throw new Error("catalog requires DPoP");
        const token = authorization.slice(5), grant = access.get(token);
        const { claims, jkt, jwk } = proof(req, token);
        if (!grant || grant.jkt !== jkt) throw new Error("catalog access token key mismatch");
        if (attested) {
          verifyIntegrity(req, "", claims, jkt, jwk);
          if (req.headers.get("content-digest") !== "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:") throw new Error("catalog empty digest mismatch");
          state.catalogSignatures.push(req.headers.get("signature")!);
        }
        if (claims.nonce !== "models-nonce" || state.catalogMode === "nonce-loop") {
          state.catalogChallenges++;
          return json({ error: "use_dpop_nonce" }, 401, { "DPoP-Nonce": "models-nonce", "WWW-Authenticate": 'DPoP error="use_dpop_nonce"' });
        }
        if (state.catalogMode === "redirect") return Response.redirect(`${origin}/stolen`, 307);
        const models = state.catalogMode === "echo" ? [{ id: token, kind: "decision" }] : state.models;
        return json({ object: "list", data: models.map(model => ({ ...model, object: "model", created: 0, owned_by: "fixture", default_dimensions: null, supported_dimensions: [] })) }, 200, { "Cache-Control": "no-store" });
      }
      if (url.pathname === "/v1/systemone") {
        state.resourceAttempts++;
        const requestBody = await req.text();
        state.resourceBodies.push(requestBody);
        state.receivedHeaders.push([...req.headers.keys()]);
        const authorization = req.headers.get("authorization");
        if (authorization === "Bearer original-fixture-key") state.bearerCalls++;
        else {
          if (!authorization?.startsWith("DPoP ")) throw new Error("Bearer was not replaced");
          const token = authorization.slice(5);
          const grant = access.get(token);
          const { claims, jkt, jwk } = proof(req, token);
          if (!grant || grant.jkt !== jkt) throw new Error("access token key mismatch");
          if (attested) {
            verifyIntegrity(req, requestBody, claims, jkt, jwk);
            state.signatures.push(req.headers.get("signature")!);
            state.signatureInputs.push(req.headers.get("signature-input")!);
          }
          if (claims.nonce !== "rs-nonce" || state.nonceLoop) { state.resourceChallenges++; return json({ error: "use_dpop_nonce" }, 401, { "DPoP-Nonce": "rs-nonce", "WWW-Authenticate": `${state.challengeScheme} error="use_dpop_nonce"` }); }
        }
        const body = JSON.parse(requestBody);
        if (authorization?.startsWith("DPoP ") && !state.models.some(model => model.id === body.model))
          return json({ error: { code: "model_not_allowed", message: "model denied" } }, 403);
        state.requests++;
        if (state.resourceDelayMs) await Bun.sleep(state.resourceDelayMs);
        if (state.redirectResource) return Response.redirect(`${origin}/stolen`, 307);
        if (state.resourceStatus !== 200) return json(state.resourceError
          ? { error: state.resourceError, ...(state.resourceReason ? { emrank_reason: state.resourceReason } : {}), error_description: authorization }
          : { error: { message: authorization } }, state.resourceStatus, { "Retry-After": "2",
            ...(state.resourceError && state.errorAuthenticate ? { "WWW-Authenticate": `DPoP error="${state.resourceError}"` } : {}) });
        if (state.resourceMode === "oversized") return json({ padding: "x".repeat(1024 * 1024) });
        if (state.resourceMode === "malformed") return new Response("{broken", { headers: { "Content-Type": "application/json" } });
        return json({ model: state.resourceMode === "echo" ? authorization : body.model,
          answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: "noul", noul: state.resourceMode === "out-of-range" ? 2 : 0.99, debug: authorization }])),
          usage: { input_tokens: 12, output_tokens: 1 }, debug: authorization });
      }
      if (url.pathname === "/stolen") throw new Error("credential redirect was followed");
      return new Response(null, { status: 404 });
    } catch (error) { state.errors.push(String(error)); return json({ error: "fixture rejected client" }, 400); }
  });
  origin = `http://127.0.0.1:${server.port}`;
  return { origin, state, stop: () => server.stop(true) };
}
