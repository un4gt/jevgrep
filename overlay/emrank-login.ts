import { parseArgs } from "node:util";
import { isCancel, password, select } from "@clack/prompts";
import { CliError } from "./errors";

export const loginUsage = "jg emrank --login [--manual] [--model ID]";

export function loginOptions(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: false, strict: true, options: {
      manual: { type: "boolean" }, model: { type: "string" },
    } }).values;
  } catch { throw new CliError(`Usage: ${loginUsage}`); }
}

export async function readManualCode(signal: AbortSignal, expiresIn: number): Promise<string> {
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new Error("login timed out")), expiresIn * 1000);
  const validate = (value: string) => value.length > 0 && value.length <= 4096 && !/\s/.test(value);
  try {
    combined.throwIfAborted();
    if (process.stdin.isTTY) {
      const value = await password({ message: "Paste the one-time authorization code", output: process.stdout, signal: combined, clearOnError: true,
        validate: value => validate(value ?? "") ? undefined : "Paste the complete code from the authorization page (up to 4096 characters).",
      });
      combined.throwIfAborted();
      if (isCancel(value)) throw new DOMException("Interrupted", "AbortError");
      return value;
    }
    process.stdout.write("Paste the one-time authorization code and press Enter:\n");
    // Bound piped input, never echo it, and remove listeners on cancellation.
    return await new Promise<string>((resolve, reject) => {
      let input = "";
      const cleanup = () => {
        process.stdin.off("data", data); process.stdin.off("end", end); process.stdin.off("error", error);
        combined.removeEventListener("abort", abort); process.stdin.pause();
      };
      const finish = (failure?: Error) => {
        cleanup();
        const value = input.trim(); input = "";
        if (failure) reject(failure);
        else if (!validate(value)) reject(new CliError("No valid authorization code was entered. Run jg emrank --login --manual again."));
        else resolve(value);
      };
      const data = (chunk: Buffer) => {
        if (chunk.length + Buffer.byteLength(input) > 4098) { finish(new CliError("Authorization code exceeds the input limit.")); return; }
        input += chunk.toString("utf8");
        if (input.includes("\n")) {
          if (input.slice(input.indexOf("\n") + 1).trim()) finish(new CliError("Enter one authorization code only."));
          else finish();
        }
      };
      const end = () => finish();
      const error = () => finish(new CliError("Could not read the authorization code."));
      const abort = () => finish(combined.reason instanceof Error ? combined.reason : new DOMException("Interrupted", "AbortError"));
      process.stdin.on("data", data).once("end", end).once("error", error);
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
      else if (process.stdin.readableEnded) end();
      else process.stdin.resume();
    });
  } catch (error) {
    if (timeout.signal.aborted && !signal.aborted) throw new CliError("Login timed out. Run jg emrank --login --manual again.");
    throw error;
  } finally { clearTimeout(timer); }
}

type ModelAPI = Pick<typeof import("@emrank/jevgrep-native"), "availableModels" | "selectModel">;

export async function chooseModel(api: ModelAPI, requested: string | undefined, signal: AbortSignal, quiet = false) {
  signal.throwIfAborted();
  const models = (await api.availableModels()).filter(model => model.kind === "decision");
  signal.throwIfAborted();
  if (!models.length)
    throw new CliError("You are signed in, but this application has no available decision models. Ask the website administrator to enable models for this OAuth application, then run jg emrank --model. No inference was sent.");
  let selected = requested;
  if (selected === undefined) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new CliError(`You are signed in. Choose a model in a terminal with jg emrank --model, or use jg emrank --model <id>.\nAvailable models:\n${models.map(model => `  ${model.id}`).join("\n")}\nNo inference was sent.`);
    const answer = await select({ message: "Choose a model for this application", output: process.stdout, signal,
      options: models.map(model => ({ value: model.id, label: model.id })),
    });
    if (isCancel(answer)) throw new DOMException("Interrupted", "AbortError");
    selected = answer;
  }
  signal.throwIfAborted();
  if (!models.some(model => model.id === selected))
    throw new CliError("That model is not available to this application. Run jg emrank --model to choose from the current list.");
  // Revalidate inside Rust before storing, since the application policy may
  // change while the terminal menu is open. Tokens never enter JavaScript.
  const session = await api.selectModel(selected);
  signal.throwIfAborted();
  if (!quiet) process.stdout.write(`Model selected: ${session.model}\n`);
  return session;
}
