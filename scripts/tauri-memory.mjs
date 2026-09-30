#!/usr/bin/env node
// Keep committed manifests memory-free. For build/dev, reconcile every Tauri
// overlay's externalBin array, then apply the target-aware array LAST.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  isMemorySidecar,
  isMemoryTargetSupported,
  memoryExternalBin,
} from "./memory-target.mjs";

const args = process.argv.slice(2);
const command = args[0];

function run(bin, argv, options = {}) {
  const result = spawnSync(bin, argv, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function runTauri(argv, env) {
  // Windows cannot spawn pnpm.cmd without a shell (which would split inline
  // JSON). Call the installed CLI via Node; pnpm exec is safe on Unix.
  if (process.platform === "win32") {
    const cli = createRequire(import.meta.url).resolve(
      "@tauri-apps/cli/tauri.js",
    );
    run(process.execPath, [cli, ...argv], { env });
  } else {
    run("pnpm", ["exec", "tauri", ...argv], { env });
  }
}

function options(name, short) {
  const values = [];
  for (let i = 1; i < args.length && args[i] !== "--"; i++) {
    const arg = args[i];
    if (arg === name || arg === short) {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        throw new Error(`Missing value for ${name}`);
      values.push(value);
    } else if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (!value) throw new Error(`Missing value for ${name}`);
      values.push(value);
    } else if (short && arg.startsWith(short) && arg.length > short.length) {
      const value = arg.slice(short.length).replace(/^=/, "");
      if (!value) throw new Error(`Missing value for ${short}`);
      values.push(value);
    }
  }
  return values;
}

function config(value) {
  const raw = value.trim().startsWith("{")
    ? value
    : readFileSync(resolve(value), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tauri config must be a JSON object");
  }
  return parsed;
}

if (
  !["build", "dev"].includes(command) ||
  args.includes("--help") ||
  args.includes("-h")
) {
  runTauri(args, process.env);
} else {
  const targets = options("--target", "-t");
  if (targets.length > 1) throw new Error("Specify exactly one compile target");
  const explicitTarget = targets.length > 0 || !!process.env.CARGO_BUILD_TARGET;
  let target = targets[0] ?? process.env.CARGO_BUILD_TARGET;
  if (!target) {
    const rustc = run("rustc", ["-vV"], { encoding: "utf8", stdio: "pipe" });
    target = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
  }
  if (
    !target ||
    !/^[a-zA-Z0-9_]+-[a-zA-Z0-9_]+-[a-zA-Z0-9_.-]+$/.test(target)
  ) {
    throw new Error("Expected a Rust compile target triple");
  }
  const separator = args.indexOf("--");
  if (
    separator >= 0 &&
    args
      .slice(separator + 1)
      .some(
        (arg) =>
          arg === "--target" ||
          arg.startsWith("--target=") ||
          arg === "-t" ||
          /^-t[^-]/.test(arg),
      )
  ) {
    throw new Error(
      "Pass the compile target before -- so Tauri and Cargo agree",
    );
  }
  // CARGO_BUILD_TARGET is already Cargo's native compile target. When set,
  // make it explicit to Tauri too. Leave host-default invocations hostless to
  // preserve their original Cargo output paths (including Linux release CI).
  if (!targets.length && explicitTarget) {
    args.splice(separator < 0 ? args.length : separator, 0, "--target", target);
  }
  const platform = target.endsWith("-apple-darwin")
    ? "macos"
    : target.includes("-windows-")
      ? "windows"
      : "linux";
  const platformPath = `src-tauri/tauri.${platform}.conf.json`;
  let externalBin =
    config("src-tauri/tauri.conf.json").bundle?.externalBin ?? [];
  const configs = [
    ...(existsSync(platformPath) ? [platformPath] : []),
    ...(process.env.TAURI_CONFIG ? [process.env.TAURI_CONFIG] : []),
    ...options("--config", "-c"),
  ];
  for (const value of configs) {
    const bin = config(value).bundle?.externalBin;
    if (bin !== undefined) externalBin = bin;
  }

  const env = { ...process.env, TAURI_ENV_TARGET_TRIPLE: target };
  delete env.VITE_MEMORY_SUPPORTED;
  delete env.BERD_MEMORY_MCP_BIN;
  // A supported Vite build must come through this wrapper: it prepares the
  // matching binary before letting Vite compile the supported UI.
  env.BERD_MEMORY_BUILD_TARGET = target;
  if (targets.length) env.CARGO_BUILD_TARGET = target;

  if (isMemoryTargetSupported(env)) {
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
    const binDir = "src-tauri/binaries";
    if (existsSync(binDir)) {
      for (const name of readdirSync(binDir)) {
        if (isMemorySidecar(name))
          rmSync(resolve(binDir, name), { force: true });
      }
    }
  }

  const finalExternalBin = memoryExternalBin(externalBin, target, command);
  if (env.TAURI_CONFIG) {
    const inherited = config(env.TAURI_CONFIG);
    env.TAURI_CONFIG = JSON.stringify({
      ...inherited,
      bundle: { ...inherited.bundle, externalBin: finalExternalBin },
    });
  }
  // RFC 7386 replaces arrays. The final inline overlay must contain the
  // ENTIRE selected nonmemory sidecar set, not just the memory addition.
  args.splice(
    args.indexOf("--") < 0 ? args.length : args.indexOf("--"),
    0,
    "--config",
    JSON.stringify({ bundle: { externalBin: finalExternalBin } }),
  );
  runTauri(args, env);
}
