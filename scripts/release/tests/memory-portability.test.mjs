import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../../..");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const read = (path) => readFileSync(join(repo, path), "utf8");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "berd-memory-portability-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  copyFileSync(
    join(repo, "scripts/test-memory-portability.mjs"),
    join(root, "scripts/test-memory-portability.mjs"),
  );
  const capture = join(root, "cargo-calls.jsonl");
  writeFileSync(
    join(root, "bin/cargo"),
    `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),offline:process.env.CARGO_NET_OFFLINE,runner:process.env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUNNER})+'\\n');process.exit(Number(process.env.MOCK_EXIT||0));\n`,
    { mode: 0o755 },
  );
  return {
    root,
    capture,
    env: {
      ...process.env,
      CAPTURE: capture,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUNNER: "must-not-run",
    },
  };
}

describe("local portability validation", () => {
  it.each([
    ["check", "x86_64-pc-windows-gnu"],
    ["check", "x86_64-unknown-linux-gnu"],
    ["check", "x86_64-apple-darwin"],
  ])("%s %s preserves default gates before opting into the crate", (mode, target) => {
    const { root, capture, env } = fixture();
    const result = spawnSync(
      process.execPath,
      ["scripts/test-memory-portability.mjs", mode, target],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toContain("--locked");
      expect(call.args).toContain("--offline");
      expect(call.args).toContain("--all-targets");
      expect(call.args).toContain(target);
      expect(call.runner).toBeUndefined();
      expect(call.offline).toBe("true");
    }
    expect(calls[0].args).not.toContain("portable-store");
    expect(calls[1].args).toContain("portable-store");
  });
  it.each([
    ["publish", "aarch64-apple-darwin"],
    ["check", "../target.json"],
    ["check", "aarch64-apple-ios"],
    ["check", "--all-features"],
    [],
  ])("rejects unsupported invocation %j", (...args) => {
    const { root, env } = fixture();
    expect(
      spawnSync(
        process.execPath,
        ["scripts/test-memory-portability.mjs", ...args],
        { cwd: root, env },
      ).status,
    ).toBe(2);
  });
  it("does not report success or continue after a failed cargo gate", () => {
    const { root, capture, env } = fixture();
    const result = spawnSync(
      process.execPath,
      ["scripts/test-memory-portability.mjs", "check", "x86_64-pc-windows-gnu"],
      { cwd: root, env: { ...env, MOCK_EXIT: "9" }, encoding: "utf8" },
    );
    expect(result.status).toBe(9);
    expect(readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain("passed");
  });
  it("does not enable desktop commands or release packaging on unaccepted targets", () => {
    const manifest = read("src-tauri/crates/berd-memory/Cargo.toml");
    expect(manifest).toContain("default = []");
    expect(manifest).toContain('features = ["windows-native"]');
    expect(manifest).toContain(
      '"sync-secret-service", "crypto-rust", "vendored"',
    );
    expect(read("src-tauri/Cargo.toml")).not.toContain("portable-store");
    expect(read("scripts/memory-target.mjs")).not.toContain("portable-store");
    expect(read("src-tauri/src/commands/mod.rs")).toContain(
      '#[cfg(all(target_os = "macos", target_arch = "aarch64"))]\npub mod memory_store;',
    );
    expect(read("src-tauri/crates/berd-memory/tests/stdio.rs")).toContain(
      "    unix,",
    );
  });
});
