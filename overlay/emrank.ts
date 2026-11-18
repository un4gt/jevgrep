import { join } from "node:path";
import { CliError } from "./errors";
import type { Credentials } from "./auth";
import { chooseModel, loginOptions, loginUsage, readManualCode } from "./emrank-login";

export const DEFAULT_SEARCH_CONCURRENCY = 4;

export function emrankHelp(upstreamHelp: string): string {
  return upstreamHelp
    .replace(/^(  --concurrency N[ \t]+).*$/m, `$1Limit in-flight Jev requests (default: ${DEFAULT_SEARCH_CONCURRENCY})`)
    .replace("Commands:\n", `Commands:
  emrank --login  Sign in to EMRank through your browser
  emrank --status Show EMRank sign-in status
  emrank --logout Sign out of EMRank and revoke authorization
  emrank --model  Choose an available model after signing in
  emrank --help   Show EMRank login options, including --manual
`);
}

async function native() {
  try { return await import("@emrank/jevgrep-native"); }
  catch { throw new CliError("EMRank native package is unavailable. Reinstall @emrank/jevgrep with optional dependencies enabled."); }
}

async function checked<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new CliError(error instanceof Error ? error.message : "EMRank operation failed.");
  }
}

export async function emrankCommand(args: string[], signal: AbortSignal): Promise<boolean> {
  if (args[0] !== "emrank") return false;
  const action = args[1];
  // Reserve only the extension's explicit flags. Literal "emrank" queries,
  // including upstream search options, keep their original meaning.
  if (!action || !["--login", "--status", "--logout", "--model", "--help"].includes(action)) return false;
  if (action === "--help" && args.length === 2) {
    process.stdout.write(`Usage: ${loginUsage}\n       jg emrank --model [ID]\n       jg emrank --status | --logout\n\nLocal test builds read EMRANK_ISSUER. Release builds use the website address set at build time. Sign in in your browser, then choose a model from the models enabled for this OAuth application.\nUse jg emrank --model to change the saved model later.\n--manual prints a sign-in link and asks you to paste the one-time code shown after authorization; no local callback is needed.\n--model ID selects an exact allowed model after login for non-interactive use.\nLogin and model selection do not run inference; doctor and queries may consume your quota.\nRegistered releases use a seven-day authorization.\nLogin activates EMRank; logout restores the original saved provider.\nSet EMRANK_PROVIDER=original to use that provider without logging out.\n`);
    return true;
  }
  if (action !== "--login" && args.length !== 2 && !(action === "--model" && args.length === 3))
    throw new CliError(`Usage: ${loginUsage} | --status | --logout`);
  const options = action === "--login" ? loginOptions(args.slice(2)) : undefined;
  const api = await native();
  if (action === "--model") {
    await checked(() => chooseModel(api, args[2], signal));
  }
  if (action === "--status") process.stdout.write(JSON.stringify(await checked(() => api.status())) + "\n");
  if (action === "--logout") {
    const result = await checked(() => api.logout());
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.remoteRevoked) process.stderr.write("Local credentials cleared. Remote revocation was not confirmed; revoke this authorization on the gateway's authorization management page.\n");
  }
  if (action === "--login") {
    signal.throwIfAborted();
    // This is an early UX check, not a security boundary: Rust still enforces
    // deployment readiness at every send, including restored sessions.
    process.stdout.write(`Signing in to ${api.configuredIssuer()}\nChoose your model after browser authorization. Login does not run inference.\n`);
    const challenge = await checked(() => api.startLogin(options!.manual ?? false));
    const cancel = () => api.cancelLogin(challenge.handle);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      process.stdout.write(`Open this URL to sign in:\n${challenge.authorizationUrl}\n`);
      let session: Awaited<ReturnType<typeof api.completeLogin>>;
      if (options!.manual) {
        process.stdout.write("After authorizing, copy the one-time code from the page and paste it here. It expires 60 seconds after authorization.\n");
        let code = await readManualCode(signal, challenge.expiresIn);
        try { session = await checked(() => api.completeManualLogin(challenge.handle, code)); }
        finally { code = ""; }
      } else session = await checked(() => api.completeLogin(challenge.handle, true));
      process.stdout.write(session.username ? `Hello ${session.username}\n` : "Hello\n");
      await checked(() => chooseModel(api, options!.model, signal, true));
      signal.throwIfAborted();
    } finally { signal.removeEventListener("abort", cancel); cancel(); }
  }
  return true;
}

type Selection = Credentials & { fetch?: typeof fetch; cacheNamespace?: string };

const maxBodyBytes = 13 * 1024 * 1024;
async function evaluationInput(request: Request, model: string) {
  if (!request.body) throw new CliError("EMRank evaluation requires a JSON body.");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      request.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) throw new CliError("EMRank evaluation exceeds 13 MiB.");
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CliError("Invalid EMRank evaluation JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("Invalid EMRank evaluation.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["model", "state", "questions"].includes(key)) || body.model !== model
    || !body.state || typeof body.state !== "object" || Array.isArray(body.state)
    || !body.questions || typeof body.questions !== "object" || Array.isArray(body.questions))
    throw new CliError("EMRank supports only the saved model and structured evaluation input.");
  const questions = Object.entries(body.questions).map(([id, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CliError("Invalid EMRank question.");
    const question = raw as Record<string, unknown>;
    if (question.type !== "noul" || typeof question.instructions !== "string"
      || Object.keys(question).some(key => !["type", "instructions"].includes(key)))
      throw new CliError("EMRank supports only relevance evaluation questions.");
    return { id, instructions: question.instructions };
  });
  return { stateJson: JSON.stringify(body.state), questions };
}

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
  if (!session.model) throw new CliError("You are signed in. Run jg emrank --model to choose a model before querying.");
  const namespace = session.cacheNamespace!;
  const signedFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const endpoint = new URL(`${session.baseUrl!.replace(/\/+$/, "")}/systemone`).href;
    if (request.method !== "POST" || request.url !== endpoint)
      throw new CliError("EMRank refuses requests outside the configured System One endpoint.");
    for (const [name, value] of request.headers) {
      if (!["authorization", "content-type", "user-agent", "accept"].includes(name)
        || (name === "authorization" && value !== "Bearer emrank-native-managed")
        || (name === "content-type" && value.toLowerCase() !== "application/json"))
        throw new CliError("Unsupported EMRank request header.");
    }
    const operation = await evaluationInput(request, session.model!);
    request.signal.throwIfAborted();
    let handle: string;
    if (api.protocolTestBuild()) { handle = api.beginEvaluation(namespace, operation); }
    else {
      const state = JSON.parse(operation.stateJson) as Record<string, unknown>;
      const kind = "items" in state ? "navigation" : "declarations" in state ? "evidence" : "preview" in state ? "file-assessment" : "doctor";
      delete state.guidance; delete state.criteria;
      if (kind === "doctor" && state.source === "export function recordEvent(event) { events.push(event); }") delete state.source;
      handle = api.beginOperation(namespace, kind, JSON.stringify(state));
    }
    const cancel = () => api.cancelEvaluation(handle);
    request.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (request.signal.aborted) cancel();
      const result = await api.completeEvaluation(handle);
      request.signal.throwIfAborted();
      const headers = new Headers({ "content-type": "application/json" });
      if (result.retryAfter) headers.set("retry-after", result.retryAfter);
      return new Response(result.body, { status: result.status, headers });
    } catch (error) {
      request.signal.throwIfAborted();
      throw error;
    } finally {
      request.signal.removeEventListener("abort", cancel);
    }
  };
  return { provider: "custom", baseURL: session.baseUrl!, model: session.model!, apiKey: "emrank-native-managed",
    fetch: signedFetch as typeof fetch, cacheNamespace: namespace };
}

export function emrankCache(directory: string, selection: Selection): string {
  return selection.cacheNamespace ? join(directory, "emrank", selection.cacheNamespace) : directory;
}
