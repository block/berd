import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MEMORY_TARGET,
  isMemoryTargetSupported,
  memoryExternalBin,
} from "../../memory-target.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const read = (name) => readFileSync(join(repo, name), "utf8");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "berd-memory-packaging-"));
  roots.push(root);
  for (const dir of ["scripts", "src-tauri/binaries", "bin"])
    mkdirSync(join(root, dir), { recursive: true });
  for (const name of [
    "scripts/tauri-memory.mjs",
    "scripts/memory-target.mjs",
    "scripts/prepare-memory-sidecar.sh",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.windows.conf.json",
    "src-tauri/tauri.macos.conf.json",
  ])
    copyFileSync(join(repo, name), join(root, name));
  const executable = (name, content) =>
    writeFileSync(join(root, "bin", name), content, { mode: 0o755 });
  executable(
    "pnpm",
    `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),env:process.env}));\n`,
  );
  executable("rustc", '#!/bin/sh\nprintf "host: %s\\n" "$MOCK_HOST"\n');
  executable(
    "cargo",
    `#!${process.execPath}\nconst fs=require('fs'); const path=require('path'); const dir=path.join(process.env.FIXTURE,'cargo-target'); fs.appendFileSync(path.join(process.env.FIXTURE,'cargo-calls'),process.argv.slice(2).join(' ')+'\\n'); if(process.argv[2]==='metadata') console.log(JSON.stringify({target_directory:dir})); else {const target=process.argv[process.argv.indexOf('--target')+1]; const out=path.join(dir,target,'release');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'berd-memory-mcp'),'synthetic',{mode:0o755});}\n`,
  );
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    FIXTURE: root,
    CAPTURE: join(root, "capture.json"),
    MOCK_HOST: MEMORY_TARGET,
  };
  for (const key of [
    "CARGO_BUILD_TARGET",
    "TAURI_CONFIG",
    "TAURI_ENV_TARGET_TRIPLE",
    "BERD_MEMORY_BUILD_TARGET",
    "BERD_MEMORY_MCP_BIN",
  ])
    delete env[key];
  return { root, env };
}

describe("compile target authority", () => {
  it.each([
    undefined,
    "",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
    "aarch64-pc-windows-msvc",
    "x86_64-pc-windows-msvc",
    "universal-apple-darwin",
    "aarch64-apple-ios",
  ])("fails closed for %s", (target) => {
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_TARGET_TRIPLE: target,
        VITE_MEMORY_SUPPORTED: "1",
      }),
    ).toBe(false);
  });
  it("accepts exactly Apple Silicon macOS, irrespective of a VITE override", () => {
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET,
        BERD_MEMORY_BUILD_TARGET: MEMORY_TARGET,
        VITE_MEMORY_SUPPORTED: "0",
      }),
    ).toBe(true);
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_PLATFORM: "darwin",
        TAURI_ENV_ARCH: "aarch64",
      }),
    ).toBe(true);
    expect(isMemoryTargetSupported({ TAURI_ENV_PLATFORM: "darwin" })).toBe(
      false,
    );
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_PLATFORM: "darwin",
        TAURI_ENV_ARCH: "arm64",
      }),
    ).toBe(false);
  });
  it("prefers explicit triple over contradictory OS/arch and ignores host metadata", () => {
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
        TAURI_ENV_PLATFORM: "darwin",
        TAURI_ENV_ARCH: "aarch64",
      }),
    ).toBe(false);
    expect(
      isMemoryTargetSupported({
        platform: "darwin",
        arch: "arm64",
        VITE_MEMORY_SUPPORTED: "1",
        CARGO_BUILD_TARGET: MEMORY_TARGET,
      }),
    ).toBe(false);
    expect(read("vite.config.ts")).toContain(
      '"import.meta.env.VITE_MEMORY_SUPPORTED": JSON.stringify(',
    );
    expect(read("vite.config.ts")).toContain(
      'isMemoryTargetSupported(process.env) ? "1" : "0"',
    );
  });
});

describe("final manifest contract", () => {
  it("base and platform defaults never require memory", () => {
    for (const name of [
      "tauri.conf.json",
      "tauri.windows.conf.json",
      "tauri.macos.conf.json",
      "tauri.dev.conf.json",
    ]) {
      expect(
        JSON.parse(read(`src-tauri/${name}`)).bundle?.externalBin ?? [],
      ).not.toContain("binaries/berd-memory-mcp");
    }
  });
  it("preserves unrelated sidecars while removing stale memory entries", () => {
    const bins = [
      "binaries/goosed",
      "custom/other",
      "binaries/berd-memory-mcp",
      "binaries/berd-memory-mcp-old.exe",
    ];
    expect(memoryExternalBin(bins, "x86_64-apple-darwin")).toEqual(
      bins.slice(0, 2),
    );
    expect(memoryExternalBin(bins, MEMORY_TARGET)).toEqual([
      ...bins.slice(0, 2),
      "binaries/berd-memory-mcp",
    ]);
    expect(memoryExternalBin(bins, MEMORY_TARGET, "dev")).toEqual(
      bins.slice(0, 2),
    );
  });
  it.each([
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
  ])("cross-build %s cannot inherit memory from any overlay or stale staging", (target) => {
    const { root, env } = fixture();
    const bins = [
      "binaries/goosed",
      "custom/retained",
      "binaries/berd-memory-mcp",
    ];
    writeFileSync(
      join(root, "release.json"),
      JSON.stringify({ bundle: { externalBin: bins } }),
    );
    for (const name of [
      "berd-memory-mcp",
      "berd-memory-mcp-aarch64-apple-darwin",
      "berd-memory-mcp-x86_64-pc-windows-msvc.exe",
      "goosed-retained",
    ])
      writeFileSync(join(root, "src-tauri/binaries", name), "stale");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/tauri-memory.mjs",
        "build",
        `--target=${target}`,
        "--config",
        "release.json",
      ],
      {
        cwd: root,
        env: {
          ...env,
          VITE_MEMORY_SUPPORTED: "1",
          BERD_MEMORY_MCP_BIN: "stale",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(readFileSync(env.CAPTURE, "utf8"));
    expect(JSON.parse(captured.args.at(-1)).bundle.externalBin).toEqual(
      bins.slice(0, 2),
    );
    expect(captured.env.TAURI_ENV_TARGET_TRIPLE).toBe(target);
    expect(captured.env.VITE_MEMORY_SUPPORTED).toBeUndefined();
    expect(captured.env.BERD_MEMORY_MCP_BIN).toBeUndefined();
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
    expect(
      existsSync(
        join(root, "src-tauri/binaries/berd-memory-mcp-aarch64-apple-darwin"),
      ),
    ).toBe(false);
    expect(existsSync(join(root, "src-tauri/binaries/goosed-retained"))).toBe(
      true,
    );
  });
  it("supported cross-build stages the selected target even on an unsupported host", () => {
    const { root, env } = fixture();
    const result = spawnSync(
      process.execPath,
      [
        "scripts/tauri-memory.mjs",
        "build",
        "--target",
        MEMORY_TARGET,
        "--config",
        '{"bundle":{"externalBin":["custom/kept"]}}',
      ],
      {
        cwd: root,
        env: { ...env, MOCK_HOST: "x86_64-unknown-linux-gnu" },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(readFileSync(env.CAPTURE, "utf8"));
    expect(JSON.parse(captured.args.at(-1)).bundle.externalBin).toEqual([
      "custom/kept",
      "binaries/berd-memory-mcp",
    ]);
    expect(readFileSync(join(root, "cargo-calls"), "utf8")).toContain(
      `build -p berd-memory --release --target ${MEMORY_TARGET}`,
    );
    expect(
      existsSync(
        join(root, `src-tauri/binaries/berd-memory-mcp-${MEMORY_TARGET}`),
      ),
    ).toBe(true);
  });
  it("dev builds its memory executable for the chosen compile target without bundling it", () => {
    const { root, env } = fixture();
    const result = spawnSync(
      process.execPath,
      [
        "scripts/tauri-memory.mjs",
        "dev",
        "--target",
        MEMORY_TARGET,
        "--config",
        '{"bundle":{"externalBin":[]}}',
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(readFileSync(env.CAPTURE, "utf8"));
    expect(JSON.parse(captured.args.at(-1)).bundle.externalBin).toEqual([]);
    expect(captured.env.BERD_MEMORY_MCP_BIN).toBe(
      join(root, "cargo-target", MEMORY_TARGET, "debug/berd-memory-mcp"),
    );
  });
  it("unknown standalone staging skips cargo and removes only stale memory", () => {
    const { root, env } = fixture();
    writeFileSync(
      join(root, "src-tauri/binaries/berd-memory-mcp-old"),
      "stale",
    );
    writeFileSync(join(root, "src-tauri/binaries/berdctl-old"), "keep");
    const result = spawnSync("bash", ["scripts/prepare-memory-sidecar.sh"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
    expect(
      existsSync(join(root, "src-tauri/binaries/berd-memory-mcp-old")),
    ).toBe(false);
    expect(existsSync(join(root, "src-tauri/binaries/berdctl-old"))).toBe(true);
  });
});

describe("entry point and CI contracts", () => {
  it("all Unix app launch paths use the final target overlay", () => {
    for (const name of [
      "justfile",
      "scripts/dev-e2e.sh",
      "scripts/release/build-macos.sh",
      ".github/workflows/release.yml",
    ]) {
      expect(read(name)).toContain("node scripts/tauri-memory.mjs");
      expect(read(name)).not.toMatch(
        /^\s*(?:.*=\S+ )?pnpm tauri (?:build|dev)/m,
      );
    }
  });
  it("Windows staging never builds memory and CI retains unsupported absence checks", () => {
    expect(read("scripts/windows/Stage-Sidecar-Windows.ps1")).not.toContain(
      '"-p", "berd-memory"',
    );
    expect(read("scripts/windows/Stage-Sidecar-Windows.ps1")).toContain(
      '"berd-memory-mcp*"',
    );
    expect(read("scripts/windows/CI-Windows.ps1")).toContain(
      '"test", "-p", "berd-memory"',
    );
    expect(read("scripts/windows/CI-Windows.ps1")).not.toContain(
      '"commands::memory_"',
    );
    expect(read("scripts/test-memory-target.sh")).toContain(
      '"$triple" == "aarch64-apple-darwin"',
    );
    expect(read("scripts/test-memory-target.sh")).toContain(
      "test -p berd-memory --target",
    );
    expect(read("justfile")).toContain("./scripts/test-memory-target.sh");
  });
});

describe("launcher argument contract", () => {
  it("rejects an explicitly empty target instead of falling back to a supported host", () => {
    const { root, env } = fixture();
    const result = spawnSync(
      process.execPath,
      ["scripts/tauri-memory.mjs", "build", "--target="],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(env.CAPTURE)).toBe(false);
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
  });
  it("Windows native build/dev drivers use the final target filter", () => {
    for (const name of [
      "scripts/windows/Bundle-Windows.ps1",
      "scripts/windows/Dev-Windows.ps1",
    ]) {
      expect(read(name)).toContain('"scripts/tauri-memory.mjs"');
      expect(read(name)).not.toContain('"exec", "tauri"');
    }
  });

  it("passes non-build Tauri commands through without staging", () => {
    const { root, env } = fixture();
    const result = spawnSync(
      process.execPath,
      ["scripts/tauri-memory.mjs", "signer", "--help"],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(env.CAPTURE, "utf8")).args).toEqual([
      "exec",
      "tauri",
      "signer",
      "--help",
    ]);
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
  });
  it("selects an explicit default compile target and inserts options before Cargo arguments", () => {
    const { root, env } = fixture();
    const result = spawnSync(
      process.execPath,
      ["scripts/tauri-memory.mjs", "build", "--", "--locked"],
      {
        cwd: root,
        env: { ...env, CARGO_BUILD_TARGET: "x86_64-unknown-linux-gnu" },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const { args } = JSON.parse(readFileSync(env.CAPTURE, "utf8"));
    expect(args.slice(-2)).toEqual(["--", "--locked"]);
    expect(args.slice(3, 5)).toEqual(["--target", "x86_64-unknown-linux-gnu"]);
  });
  it("preserves the Windows sidecar set after a release overlay containing no sidecars", () => {
    const { root, env } = fixture();
    const result = spawnSync(
      process.execPath,
      [
        "scripts/tauri-memory.mjs",
        "build",
        "-t",
        "x86_64-pc-windows-msvc",
        "-c",
        '{"bundle":{"resources":{"catalog":"catalog"}}}',
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const { args } = JSON.parse(readFileSync(env.CAPTURE, "utf8"));
    expect(JSON.parse(args.at(-1)).bundle.externalBin).toEqual([
      "binaries/goosed",
      "binaries/berdctl",
      "binaries/berd-monitor",
    ]);
  });
});

describe("Vite compile-time capability", () => {
  it.each([
    [{}, "0"],
    [{ VITE_MEMORY_SUPPORTED: "1" }, "0"],
    [
      {
        TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET,
        BERD_MEMORY_BUILD_TARGET: MEMORY_TARGET,
        VITE_MEMORY_SUPPORTED: "0",
      },
      "1",
    ],
    [
      {
        TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin",
        VITE_MEMORY_SUPPORTED: "1",
      },
      "0",
    ],
    [
      {
        TAURI_ENV_TARGET_TRIPLE: "aarch64-unknown-linux-gnu",
        TAURI_ENV_PLATFORM: "darwin",
        TAURI_ENV_ARCH: "aarch64",
      },
      "0",
    ],
  ])("defines availability from target metadata %j", (metadata, expected) => {
    const env = { ...process.env };
    for (const key of [
      "TAURI_ENV_TARGET_TRIPLE",
      "TAURI_ENV_PLATFORM",
      "TAURI_ENV_ARCH",
      "VITE_MEMORY_SUPPORTED",
    ])
      delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { loadConfigFromFile } from "vite"; const c = await loadConfigFromFile({command:"build",mode:"production"},"vite.config.ts"); console.log(c.config.define["import.meta.env.VITE_MEMORY_SUPPORTED"]);',
      ],
      {
        cwd: repo,
        env: { ...env, ...metadata },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toBe(expected);
  });
});

describe("target disagreement and direct CLI guards", () => {
  it.each([
    ["--target", MEMORY_TARGET, "--target", "x86_64-apple-darwin"],
    ["-t", MEMORY_TARGET, "--target", MEMORY_TARGET],
    ["--target"],
    ["--target", "--config"],
    ["-t="],
    ["--target", "not a triple"],
    ["--target", "../target.json"],
    ["--target", MEMORY_TARGET, "--", "--target", "x86_64-apple-darwin"],
  ])("rejects ambiguous/malformed compile arguments %j before staging", (...argv) => {
    const { root, env } = fixture();
    const result = spawnSync(
      process.execPath,
      ["scripts/tauri-memory.mjs", "build", ...argv],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(env.CAPTURE)).toBe(false);
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
  });
  it.each([
    "-tx86_64-apple-darwin",
    "-t=x86_64-apple-darwin",
  ])("accepts short target form %s and reconciles inherited env/config", (arg) => {
    const { root, env } = fixture();
    const inherited = {
      bundle: { externalBin: ["custom/retained", "binaries/berd-memory-mcp"] },
    };
    const result = spawnSync(
      process.execPath,
      ["scripts/tauri-memory.mjs", "build", arg],
      {
        cwd: root,
        env: {
          ...env,
          CARGO_BUILD_TARGET: MEMORY_TARGET,
          TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET,
          TAURI_CONFIG: JSON.stringify(inherited),
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(readFileSync(env.CAPTURE, "utf8"));
    expect(captured.env.CARGO_BUILD_TARGET).toBe("x86_64-apple-darwin");
    expect(captured.env.TAURI_ENV_TARGET_TRIPLE).toBe("x86_64-apple-darwin");
    expect(JSON.parse(captured.env.TAURI_CONFIG).bundle.externalBin).toEqual([
      "custom/retained",
    ]);
    expect(JSON.parse(captured.args.at(-1)).bundle.externalBin).toEqual([
      "custom/retained",
    ]);
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
  });
  it("rejects supported Vite builds that bypass sidecar preparation", () => {
    const env = { ...process.env, TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET };
    delete env.BERD_MEMORY_BUILD_TARGET;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { loadConfigFromFile } from "vite"; await loadConfigFromFile({command:"build",mode:"production"},"vite.config.ts");',
      ],
      { cwd: repo, env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("prepare the matching sidecar");
  });
});

describe("package command integration", () => {
  it("routes direct pnpm tauri build/dev/custom commands through target and sidecar preparation", () => {
    expect(JSON.parse(read("package.json")).scripts.tauri).toBe(
      "node scripts/tauri-memory.mjs",
    );
  });
});

describe("memory Rust test selection", () => {
  it.each([
    MEMORY_TARGET,
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
  ])("retains all cfg-gated crate tests for %s", (target) => {
    const { root, env } = fixture();
    copyFileSync(
      join(repo, "scripts/test-memory-target.sh"),
      join(root, "scripts/test-memory-target.sh"),
    );
    writeFileSync(
      join(root, "bin/just"),
      `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2))+'\\n');`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["scripts/test-memory-target.sh"], {
      cwd: root,
      env: { ...env, CARGO_BUILD_TARGET: target },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(env.CAPTURE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0]).toEqual([
      "_tauri-cargo-unix",
      "test",
      "-p",
      "berd-memory",
      "--target",
      target,
    ]);
    expect(calls).toHaveLength(target === MEMORY_TARGET ? 2 : 1);
    if (target === MEMORY_TARGET)
      expect(calls[1]).toContain("commands::memory_");
  });
});
