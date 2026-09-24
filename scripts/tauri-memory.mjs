#!/usr/bin/env node
// Target-aware entry point for desktop build/dev. Bare Tauri manifests are
// deliberately memory-free. Apply this overlay LAST, after platform/release
// and custom overlays, so an old full-manifest overlay cannot re-enable memory.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { MEMORY_TARGET, memoryExternalBin } from "./memory-target.mjs";

const args = process.argv.slice(2);
const command = args[0];
function optionValues(name, short) {
  const values = [];
  for (let i = 1; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === name || args[i] === short) {
      const value = args[++i];
      if (value === undefined || value.startsWith("-"))
        throw new Error(`Missing value for ${name}`);
      values.push(value);
    } else if (args[i].startsWith(`${name}=`))
      values.push(args[i].slice(name.length + 1));
    else if (
      short &&
      args[i].startsWith(short) &&
      args[i].length > short.length
    )
      values.push(args[i].slice(short.length).replace(/^=/, ""));
  }
  return values;
}
function run(bin, argv, options = {}) {
  const result = spawnSync(bin, argv, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}
function runTauri(argv, options = {}) {
  // Windows pnpm.cmd cannot be spawned without a shell. Invoke the installed
  // CLI with Node instead, preserving JSON overlays as a single argv value.
  if (process.platform === "win32") {
    const cli = createRequire(import.meta.url).resolve(
      "@tauri-apps/cli/tauri.js",
    );
    return run(process.execPath, [cli, ...argv], options);
  }
  return run("pnpm", ["exec", "tauri", ...argv], options);
}
if (
  !["build", "dev"].includes(command) ||
  args.includes("--help") ||
  args.includes("-h")
) {
  runTauri(args);
  process.exit(0);
}

// Select a compile target explicitly, then give that same target to Cargo,
// Tauri, staging and Vite. rustc is used only to choose the default native
// compile target; the renderer resolver never falls back to the build host.
const targets = optionValues("--target", "-t");
if (targets.length > 1) throw new Error("Specify exactly one compile target");
if (targets.length && !targets.at(-1)?.trim()) {
  throw new Error("Explicit compile target must not be empty");
}
let target = targets.at(-1) ?? process.env.CARGO_BUILD_TARGET;
if (!target) {
  const rustc = run("rustc", ["-vV"], { encoding: "utf8", stdio: "pipe" });
  target = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
}
if (!target || !/^[a-zA-Z0-9_]+-[a-zA-Z0-9_]+-[a-zA-Z0-9_.-]+$/.test(target)) {
  throw new Error("Expected an explicit Rust target triple");
}
const cargoSeparator = args.indexOf("--");
if (
  cargoSeparator >= 0 &&
  args
    .slice(cargoSeparator + 1)
    .some(
      (arg) =>
        arg === "--target" ||
        arg.startsWith("--target=") ||
        arg === "-t" ||
        /^-t[^-]/.test(arg),
    )
) {
  throw new Error("Pass the compile target before -- so Tauri and Cargo agree");
}
if (!targets.length) {
  const separator = args.indexOf("--");
  args.splice(separator < 0 ? args.length : separator, 0, "--target", target);
}
const platform = target.includes("apple-darwin")
  ? "macos"
  : target.includes("windows")
    ? "windows"
    : "linux";
const readConfig = (value) =>
  JSON.parse(
    value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8"),
  );
let externalBin =
  readConfig("src-tauri/tauri.conf.json").bundle?.externalBin ?? [];
const platformPath = `src-tauri/tauri.${platform}.conf.json`;
const configs = [
  ...(existsSync(platformPath) ? [platformPath] : []),
  ...(process.env.TAURI_CONFIG ? [process.env.TAURI_CONFIG] : []),
  ...optionValues("--config", "-c"),
];
for (const config of configs) {
  const bins = readConfig(config).bundle?.externalBin;
  if (bins !== undefined) externalBin = bins ?? [];
}
const binDir = "src-tauri/binaries";
// Remove only memory's staged artifacts; unrelated sidecars must survive.
if (target !== MEMORY_TARGET && existsSync(binDir)) {
  for (const name of readdirSync(binDir)) {
    if (/^berd-memory-mcp(?:[.-].*)?$/.test(name))
      rmSync(resolve(binDir, name));
  }
}
const env = {
  ...process.env,
  CARGO_BUILD_TARGET: target,
  TAURI_ENV_TARGET_TRIPLE: target,
};
delete env.BERD_MEMORY_BUILD_TARGET;
delete env.VITE_MEMORY_SUPPORTED;
if (target === MEMORY_TARGET) {
  if (command === "build") {
    run("bash", ["scripts/prepare-memory-sidecar.sh", target], { env });
  } else {
    run("cargo", ["build", "-p", "berd-memory", "--target", target], {
      cwd: "src-tauri",
      env,
    });
    const metadata = run(
      "cargo",
      ["metadata", "--no-deps", "--format-version", "1"],
      {
        cwd: "src-tauri",
        env,
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    env.BERD_MEMORY_MCP_BIN = resolve(
      JSON.parse(metadata.stdout).target_directory,
      target,
      "debug/berd-memory-mcp",
    );
  }
} else {
  delete env.BERD_MEMORY_MCP_BIN;
}
const finalExternalBin = memoryExternalBin(externalBin, target, command);
const overlay = JSON.stringify({ bundle: { externalBin: finalExternalBin } });
if (env.TAURI_CONFIG) {
  const inherited = readConfig(env.TAURI_CONFIG);
  env.TAURI_CONFIG = JSON.stringify({
    ...inherited,
    bundle: { ...inherited.bundle, externalBin: finalExternalBin },
  });
}
// Vite rejects supported-target direct CLI builds that bypass this sidecar
// preparation step. This marker never enables an unsupported compile target.
env.BERD_MEMORY_BUILD_TARGET = target;
const separator = args.indexOf("--");
args.splice(separator < 0 ? args.length : separator, 0, "--config", overlay);
runTauri(args, { env });
