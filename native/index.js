import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
let binding;
function load() {
  if (binding) return binding;
  const local = fileURLToPath(new URL("./jevgrep-native.node", import.meta.url));
  if (existsSync(local)) return binding = require(local);
  const platform = process.platform === "win32" && process.arch === "x64" ? "win32-x64-msvc"
    : process.platform === "linux" && process.arch === "x64" && process.report?.getReport().header.glibcVersionRuntime ? "linux-x64-gnu" : undefined;
  if (!platform) throw new Error("EMRank native module supports Windows x64 and Linux x64 glibc. Use EMRANK_PROVIDER=original for the original provider.");
  try { return binding = require(`@emrank/jevgrep-native-${platform}`); }
  catch { throw new Error("EMRank native binary is missing or incompatible. Reinstall with optional dependencies enabled."); }
}
export const status = (...args) => load().status(...args);
export const login = (...args) => load().login(...args);
export const startLogin = (...args) => load().startLogin(...args);
export const completeLogin = (...args) => load().completeLogin(...args);
export const cancelLogin = (...args) => load().cancelLogin(...args);
export const logout = (...args) => load().logout(...args);
export const authorizeRequest = (...args) => load().authorizeRequest(...args);
export const acceptNonce = (...args) => load().acceptNonce(...args);
