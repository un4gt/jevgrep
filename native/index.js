import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let binding;
function load() {
  if (binding) return binding;
  const platform = process.platform === "win32" && process.arch === "x64" ? "win32-x64-msvc"
    : process.platform === "linux" && process.arch === "x64" && process.report?.getReport().header.glibcVersionRuntime ? "linux-x64-gnu" : undefined;
  if (!platform) throw new Error("EMRank native module supports Windows x64 and Linux x64 glibc. Use EMRANK_PROVIDER=original for the original provider.");
  try {
    const name = `@emrank/jevgrep-native-${platform}`;
    const version = require("./package.json").version;
    const pkg = require(`${name}/package.json`);
    if (pkg.name !== name || pkg.version !== version) throw new Error();
    const module = require(name);
    if (module.buildInfo().version !== version) throw new Error();
    return binding = module;
  }
  catch { throw new Error("EMRank native binary is missing or incompatible. Reinstall with optional dependencies enabled."); }
}
export const status = (...args) => load().status(...args);
export const login = (...args) => load().login(...args);
export const startLogin = (...args) => load().startLogin(...args);
export const completeLogin = (...args) => load().completeLogin(...args);
export const completeManualLogin = (...args) => load().completeManualLogin(...args);
export const cancelLogin = (...args) => load().cancelLogin(...args);
export const logout = (...args) => load().logout(...args);
export const beginEvaluation = (...args) => load().beginEvaluation(...args);
export const completeEvaluation = (...args) => load().completeEvaluation(...args);
export const cancelEvaluation = (...args) => load().cancelEvaluation(...args);
export const protocolTestBuild = (...args) => load().protocolTestBuild(...args);
export const configuredIssuer = (...args) => load().configuredIssuer(...args);
export const availableModels = (...args) => load().availableModels(...args);
export const selectModel = (...args) => load().selectModel(...args);

export const beginOperation = (...args) => load().beginOperation(...args);
export const buildInfo = () => load().buildInfo();
