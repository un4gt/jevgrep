import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// Resolve from the actual CLI installation, including tarball-only tests.
const require = createRequire(process.env.JG_TEST_CLI);
const api = await import(pathToFileURL(require.resolve("@emrank/jevgrep-native")).href);
const mode = process.argv[2];
const exported = Object.keys(api).sort();
let loggedIn = false;
const input = () => ({ stateJson: JSON.stringify({ source: "export function recordEvent() {}", query: "events" }),
  questions: [{ id: "q0", instructions: "Does this source record events?" }] });
const errorOf = async action => {
  try { await action(); return null; }
  catch (error) { return error.message; }
};
async function fragmentedCallback(authorizationUrl) {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  const callback = new URL(response.headers.get("location"));
  if (callback.hostname !== "127.0.0.1" || callback.pathname !== "/callback") throw new Error("Unexpected test callback");
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(callback.port) });
    let received = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("Fragmented callback timed out")));
    socket.on("data", chunk => { received += chunk.toString(); });
    socket.on("error", reject);
    socket.on("end", () => received.startsWith("HTTP/1.1 200") ? resolve() : reject(new Error("Fragmented callback rejected")));
    socket.on("connect", () => {
      void (async () => {
        for (const part of ["GET ", `${callback.pathname}${callback.search} `, "HTTP/1.1\r\n", `Host: ${callback.host}\r\n`, "Connection: close\r\n\r\n"]) {
          if (socket.destroyed) return;
          socket.write(part);
          await delay(30);
        }
      })().catch(reject);
    });
  });
}
try {
  if (mode.startsWith("manual-")) {
    let challenge, result, error, repeated;
    try {
      challenge = await api.startLogin(true);
      const response = await fetch(challenge.authorizationUrl);
      const data = await response.json();
      let raw = data.manual_code;
      let payload = JSON.parse(Buffer.from(raw.slice(8), "base64url"));
      if (mode === "manual-wrong-state") payload.state = "another-login";
      if (mode === "manual-wrong-issuer") payload.iss = "https://wrong.invalid";
      if (mode === "manual-extra") payload.extra = true;
      if (mode === "manual-code-and-error") payload.error = "access_denied";
      if (mode === "manual-other-attempt" || mode === "manual-replay") {
        const previousCode = payload.code;
        if (mode === "manual-replay") { await api.completeManualLogin(challenge.handle, raw); await api.logout(); }
        else api.cancelLogin(challenge.handle);
        challenge = await api.startLogin(true);
        const next = await (await fetch(challenge.authorizationUrl)).json();
        payload = JSON.parse(Buffer.from(next.manual_code.slice(8), "base64url"));
        payload.code = previousCode;
      }
      raw = "emrank1." + Buffer.from(JSON.stringify(payload)).toString("base64url");
      if (mode === "manual-duplicate") raw = "emrank1." + Buffer.from(JSON.stringify(payload).replace('"state":', '"state":"duplicate","state":')).toString("base64url");
      if (mode === "manual-padding") raw += "=";
      if (mode === "manual-url") raw = "http://127.0.0.1/callback?code=not-accepted";
      if (mode === "manual-oversized") raw = "a".repeat(4097);
      if (mode === "manual-cancel") api.cancelLogin(challenge.handle);
      if (mode === "manual-timeout") await delay(1100);
      result = await api.completeManualLogin(challenge.handle, raw);
      loggedIn = true;
    } catch (caught) { error = caught.message; }
    if (challenge) {
      repeated = await errorOf(() => api.completeManualLogin(challenge.handle, "invalid"));
      api.cancelLogin(challenge.handle);
    }
    process.stdout.write(JSON.stringify({ result, error, repeated, status: await api.status() }) + "\n");
  } else if (mode === "production" || mode === "start-error") {
    const error = await errorOf(() => api.startLogin());
    const manualError = mode === "production" ? await errorOf(() => api.startLogin(true)) : undefined;
    process.stdout.write(JSON.stringify({ testBuild: api.protocolTestBuild(), issuer: api.configuredIssuer(), exported, error, manualError }) + "\n");
  } else {
    const challenge = await api.startLogin();
    const complete = api.completeLogin(challenge.handle, false);
    await Promise.all([complete, mode === "fragmented-login"
      ? fragmentedCallback(challenge.authorizationUrl) : fetch(challenge.authorizationUrl)]);
    loggedIn = true;
    const session = await api.selectModel(process.env.EMRANK_MODEL || "fixture/jev");
    // Resource operations must not use Node fetch or expose authentication.
    globalThis.fetch = () => { throw new Error("JS resource fetch must not be called"); };
    if (mode === "invalid") {
      const values = [
        { stateJson: "[]", questions: input().questions },
        { stateJson: "{}", questions: input().questions },
        { stateJson: "{broken", questions: input().questions },
        { ...input(), questions: [] },
        { ...input(), questions: [input().questions[0], input().questions[0]] },
        { ...input(), questions: [{ id: "../elsewhere", instructions: "test" }] },
        { ...input(), questions: [{ id: "q", instructions: "x".repeat(65537) }] },
        { ...input(), stateJson: "x".repeat(13 * 1024 * 1024 + 1) },
      ];
      const errors = [];
      for (const value of values) errors.push(await errorOf(() => api.beginEvaluation(session.cacheNamespace, value)));
      errors.push(await errorOf(() => api.beginEvaluation(session.cacheNamespace, input(), 60001)));
      const handle = api.beginEvaluation("wrong-session", input());
      errors.push(await errorOf(() => api.completeEvaluation(handle)));
      process.stdout.write(JSON.stringify({ exported, errors }) + "\n");
    } else if (mode === "cancel-before") {
      const handle = api.beginEvaluation(session.cacheNamespace, input());
      api.cancelEvaluation(handle);
      const error = await errorOf(() => api.completeEvaluation(handle));
      process.stdout.write(JSON.stringify({ error }) + "\n");
    } else {
      const value = input();
      const handle = api.beginEvaluation(session.cacheNamespace, value, mode === "timeout" ? 500 : undefined);
      // Mutating JS data after admission cannot alter the native payload.
      value.stateJson = '{"source":"modified after admission"}';
      value.questions[0].instructions = "modified after admission";
      const start = Date.now();
      const timer = mode === "cancel" ? setTimeout(() => api.cancelEvaluation(handle), 500) : undefined;
      let result, error;
      try { result = await api.completeEvaluation(handle); }
      catch (caught) { error = caught.message; }
      finally { clearTimeout(timer); }
      const repeated = await errorOf(() => api.completeEvaluation(handle));
      let second, secondError;
      if (mode === "profile-repeat") {
        try { second = await api.completeEvaluation(api.beginEvaluation(session.cacheNamespace, input())); }
        catch (caught) { secondError = caught.message; }
      }
      process.stdout.write(JSON.stringify({ exported, result, error, repeated, second, secondError, status: await api.status(), elapsedMs: Date.now() - start }) + "\n");
    }
  }
} finally {
  if (loggedIn) await api.logout();
}
