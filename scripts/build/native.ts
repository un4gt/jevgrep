import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { root, run } from "../common";
const target = process.env.EMRANK_TARGET;
await run(["cargo", "build", "--release", "--locked", "--manifest-path", "native/Cargo.toml", ...(target ? ["--target", target] : [])]);
const windows = target ? target.includes("windows") : process.platform === "win32";
const library = windows ? "emrank_jevgrep_native.dll" : process.platform === "darwin" ? "libemrank_jevgrep_native.dylib" : "libemrank_jevgrep_native.so";
await cp(resolve(root, "native/target", target ?? "", "release", library), resolve(root, "native/jevgrep-native.node"));
