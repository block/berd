#!/usr/bin/env node
// Local synthetic validation only. Does not build/run Berd, stage a sidecar,
// start a credential service, change desktop availability, or contact CI.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 2 || !["check", "test"].includes(args[0])) {
  console.error(
    "Usage: node scripts/test-memory-portability.mjs <check|test> <rust-target>",
  );
  process.exit(2);
}
const [mode, target] = args;
const targets = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
  "x86_64-pc-windows-gnu",
]);
if (!targets.has(target)) {
  console.error(
    "Unsupported validation target; use an explicit desktop target from this script.",
  );
  process.exit(2);
}
const os = target.includes("apple-darwin")
  ? "darwin"
  : target.includes("windows")
    ? "win32"
    : "linux";
const arch = target.startsWith("aarch64-") ? "arm64" : "x64";
if (
  mode === "test" &&
  (process.platform !== os ||
    (process.arch !== arch &&
      !(
        process.platform === "darwin" &&
        process.arch === "arm64" &&
        arch === "x64"
      )))
) {
  console.error(
    "Tests need the matching local OS/CPU (Intel on Apple silicon may use Rosetta). Use check for cross-compilation.",
  );
  process.exit(2);
}
const manifest = fileURLToPath(
  new URL("../src-tauri/Cargo.toml", import.meta.url),
);
const env = { ...process.env, CARGO_NET_OFFLINE: "true" };
// Never inherit a custom runner that could execute on a remote host.
for (const key of Object.keys(env)) {
  if (/^CARGO_TARGET_.*_RUNNER$/.test(key)) delete env[key];
}
const common = [
  "--locked",
  "--offline",
  "--manifest-path",
  manifest,
  "-p",
  "berd-memory",
  "--target",
  target,
];
const run = (argv) => {
  const result = spawnSync("cargo", argv, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
// First retain the normal absence boundary. The opt-in only exercises this
// crate's real encrypted store and MCP; app/native packaging gates stay closed.
run([mode, ...common, ...(mode === "check" ? ["--all-targets"] : [])]);
run([
  mode,
  ...common,
  "--features",
  "portable-store",
  ...(mode === "check" ? ["--all-targets"] : []),
]);
console.log(
  "Memory portability checks passed. This is not OS-keystore, full-app, packaging, or release acceptance.",
);
