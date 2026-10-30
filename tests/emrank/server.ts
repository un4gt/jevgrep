import { createHash, createPublicKey, verify } from "node:crypto";
const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
const json = (body: unknown, status = 200, headers = {}) => Response.json(body, { status, headers });

// A protocol peer, not a replacement native client: independently checks ES256,
// PKCE, proof replay, htm/htu/ath, code/key binding, rotation and revocation.
export function oauthServer() {
  const codes = new Map<string, { challenge: string; redirect: string; jkt: string; account: string }>();
  const access = new Map<string, { jkt: string; account: string }>();
  const refresh = new Map<string, { jkt: string; account: string }>();
  const seen = new Set<string>();
  const state = { account: "account-a", tokenType: "DPoP", expiresIn: 3600, refreshes: 0, requests: 0,
    tokenChallenges: 0, resourceChallenges: 0, revoked: false, deny: false, invalidGrant: false,
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
    return { claims, jkt: hash(JSON.stringify({ crv, kty, x, y })) };
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, revocation_endpoint: `${origin}/oauth/revoke`,
        code_challenge_methods_supported: ["S256"], dpop_signing_alg_values_supported: ["ES256"], authorization_response_iss_parameter_supported: true });
      if (url.pathname === "/oauth/authorize") {
        const q = url.searchParams;
        if (q.get("code_challenge_method") !== "S256" || q.get("client_id") !== "emrank-jevgrep" || q.get("response_type") !== "code" || q.get("resource") !== `${origin}/v1`) throw new Error("invalid authorize request");
        const redirect = new URL(q.get("redirect_uri")!);
        if (redirect.hostname !== "127.0.0.1" || redirect.protocol !== "http:" || redirect.pathname !== "/callback") throw new Error("invalid callback");
        const code = crypto.randomUUID();
        codes.set(code, { challenge: q.get("code_challenge")!, jkt: q.get("dpop_jkt")!, redirect: redirect.href, account: state.account });
        redirect.searchParams.set("state", q.get("state")!);
        redirect.searchParams.set("iss", origin);
        redirect.searchParams.set(state.deny ? "error" : "code", state.deny ? "access_denied" : code);
        return Response.redirect(redirect.href, 302);
      }
      if (url.pathname === "/oauth/token") {
        const { claims, jkt } = proof(req);
        if (claims.nonce !== "as-nonce") { state.tokenChallenges++; return json({ error: "use_dpop_nonce" }, 400, { "DPoP-Nonce": "as-nonce" }); }
        const form = new URLSearchParams(await req.text());
        if (form.get("client_id") !== "emrank-jevgrep" || form.get("resource") !== `${origin}/v1`) throw new Error("wrong client or resource");
        let account: string;
        if (form.get("grant_type") === "authorization_code") {
          const code = codes.get(form.get("code")!);
          if (!code || code.challenge !== hash(form.get("code_verifier")!) || code.redirect !== form.get("redirect_uri") || code.jkt !== jkt) throw new Error("PKCE, redirect or key binding failed");
          codes.delete(form.get("code")!); account = code.account;
        } else {
          state.refreshes++;
          const grant = refresh.get(form.get("refresh_token")!);
          if (!grant || grant.jkt !== jkt || state.invalidGrant) return json({ error: "invalid_grant" }, 400);
          refresh.delete(form.get("refresh_token")!); account = grant.account;
        }
        const at = `access-${crypto.randomUUID()}`, rt = `refresh-${crypto.randomUUID()}`;
        access.set(at, { jkt, account }); refresh.set(rt, { jkt, account });
        return json({ access_token: at, refresh_token: rt, token_type: state.tokenType, expires_in: state.expiresIn, account_id: account });
      }
      if (url.pathname === "/oauth/revoke") {
        const { jkt } = proof(req);
        const form = new URLSearchParams(await req.text());
        const grant = refresh.get(form.get("token")!);
        if (!grant || grant.jkt !== jkt) throw new Error("bad revocation");
        refresh.delete(form.get("token")!);
        for (const [token, value] of access) if (value.jkt === jkt) access.delete(token);
        state.revoked = true; return new Response(null, { status: 200 });
      }
      if (url.pathname === "/v1/systemone") {
        const authorization = req.headers.get("authorization");
        if (authorization === "Bearer original-fixture-key") state.bearerCalls++;
        else {
          if (!authorization?.startsWith("DPoP ")) throw new Error("Bearer was not replaced");
          const token = authorization.slice(5);
          const grant = access.get(token);
          const { claims, jkt } = proof(req, token);
          if (!grant || grant.jkt !== jkt) throw new Error("access token key mismatch");
          if (claims.nonce !== "rs-nonce" || state.nonceLoop) { state.resourceChallenges++; return json({ error: "use_dpop_nonce" }, 401, { "DPoP-Nonce": "rs-nonce", "WWW-Authenticate": 'DPoP error="use_dpop_nonce"' }); }
        }
        state.requests++;
        if (state.redirectResource) return Response.redirect(`${origin}/stolen`, 307);
        if (state.resourceStatus !== 200) return json({ error: { message: authorization } }, state.resourceStatus);
        const body = await req.json() as any;
        return json({ answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: "noul", noul: 0.99 }])) });
      }
      if (url.pathname === "/stolen") throw new Error("credential redirect was followed");
      return new Response(null, { status: 404 });
    } catch (error) { state.errors.push(String(error)); return json({ error: "fixture rejected client" }, 400); }
  } });
  origin = `http://127.0.0.1:${server.port}`;
  return { origin, state, stop: () => server.stop(true) };
}
