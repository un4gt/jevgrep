import { join } from "node:path";
import { CliError } from "./errors";
import type { Credentials } from "./auth";

async function native() {
  try { return await import("@emrank/jevgrep-native"); }
  catch { throw new CliError("EMRank native package is unavailable. Reinstall @emrank/jevgrep with optional dependencies enabled."); }
}

async function checked<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : "EMRank operation failed."); }
}

export async function emrankCommand(args: string[], signal: AbortSignal): Promise<boolean> {
  if (args[0] !== "emrank") return false;
  const action = args[1];
  // Reserve only the extension's explicit flags. Literal "emrank" queries,
  // including upstream search options, keep their original meaning.
  if (!action || !["--login", "--status", "--logout", "--help"].includes(action)) return false;
  if (action === "--help" && args.length === 2) {
    process.stdout.write("Usage: jg emrank --login [--no-browser] | --status | --logout\nLogin activates EMRank; logout restores the original saved provider.\nSet EMRANK_PROVIDER=original to use that provider without logging out.\n");
    return true;
  }
  if (!["--login", "--status", "--logout"].includes(action!)
    || (args.length !== 2 && !(action === "--login" && args.length === 3 && args[2] === "--no-browser")))
    throw new CliError("Usage: jg emrank --login [--no-browser] | --status | --logout");
  const api = await native();
  if (action === "--status") process.stdout.write(JSON.stringify(await checked(() => api.status())) + "\n");
  if (action === "--logout") process.stdout.write(JSON.stringify(await checked(() => api.logout())) + "\n");
  if (action === "--login") {
    signal.throwIfAborted();
    const challenge = await checked(() => api.startLogin());
    const cancel = () => api.cancelLogin(challenge.handle);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      process.stdout.write(`Open this URL to sign in:\n${challenge.authorizationUrl}\n`);
      const session = await checked(() => api.completeLogin(challenge.handle, !args.includes("--no-browser")));
      signal.throwIfAborted();
      process.stdout.write(JSON.stringify(session) + "\n");
    } finally { signal.removeEventListener("abort", cancel); }
  }
  return true;
}

type Selection = Credentials & { fetch?: typeof fetch; cacheNamespace?: string };

export async function emrankCredentials(original: () => Promise<Credentials>): Promise<Selection> {
  const mode = process.env.EMRANK_PROVIDER ?? "auto";
  if (!["auto", "original", "emrank"].includes(mode)) throw new CliError("EMRANK_PROVIDER must be auto, original or emrank.");
  if (mode === "original") return original();
  const api = await native();
  const session = await checked(() => api.status());
  if (!session.authenticated) {
    if (mode === "emrank" || session.requiresLogin) throw new CliError("Run jg emrank --login first, or explicitly use --logout to restore the original provider.");
    return original();
  }
  const namespace = session.cacheNamespace!;
  const signedFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    // Cloning before consumption preserves Request bodies and abort signals for one nonce retry.
    const replay = request.clone();
    for (let attempt = 0; attempt < 2; attempt++) {
      request.signal.throwIfAborted();
      const signed = await api.authorizeRequest(request.method, request.url, namespace);
      request.signal.throwIfAborted();
      const headers = new Headers(request.headers);
      headers.set("Authorization", signed.authorization);
      headers.set("DPoP", signed.dpop);
      const response = await fetch(new Request(attempt ? replay : request, { headers, redirect: "manual" }));
      const nonce = response.headers.get("dpop-nonce");
      if (nonce) await api.acceptNonce(request.url, nonce, namespace);
      const challenged = response.status === 401 && /\buse_dpop_nonce\b/.test(response.headers.get("www-authenticate") ?? "");
      if (!attempt && challenged && nonce) { await response.body?.cancel(); continue; }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("EMRank redirects are not allowed.");
      }
      if (!response.ok) {
        // The upstream diagnostic knows only a placeholder key, so never forward a body
        // that might echo the real OAuth token or proof into its diagnostic output.
        await response.body?.cancel();
        const safe = new Headers();
        const retry = response.headers.get("retry-after");
        if (retry) safe.set("retry-after", retry);
        safe.set("content-type", "application/json");
        return new Response(JSON.stringify({ error: { message: "EMRank request rejected" } }), { status: response.status, headers: safe });
      }
      return response;
    }
    throw new Error("EMRank DPoP nonce challenge failed.");
  };
  return { provider: "custom", baseURL: session.baseUrl!, model: session.model!, apiKey: "emrank-native-managed",
    fetch: signedFetch as typeof fetch, cacheNamespace: namespace };
}

export function emrankCache(directory: string, selection: Selection): string {
  return selection.cacheNamespace ? join(directory, "emrank", selection.cacheNamespace) : directory;
}
