import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MEMORY_BIN,
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
const read = (path) => readFileSync(join(repo, path), "utf8");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "berd-memory-package-"));
  roots.push(root);
  for (const dir of ["scripts", "src-tauri/binaries", "bin"])
    mkdirSync(join(root, dir), { recursive: true });
  for (const file of [
    "scripts/tauri-memory.mjs",
    "scripts/memory-target.mjs",
    "scripts/prepare-memory-sidecar.sh",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.macos.conf.json",
    "src-tauri/tauri.windows.conf.json",
  ])
    copyFileSync(join(repo, file), join(root, file));
  function mock(name, contents) {
    writeFileSync(join(root, "bin", name), contents, { mode: 0o755 });
  }
  mock(
    "rustc",
    '#!/usr/bin/env node\nprocess.stdout.write("host: " + process.env.MOCK_HOST + "\\n");\n',
  );
  mock(
    "pnpm",
    '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),env:process.env}));\n',
  );
  mock(
    "cargo",
    '#!/usr/bin/env node\nconst fs=require("fs"),path=require("path"); const args=process.argv.slice(2),root=process.env.FIXTURE,dir=path.join(root,"cargo-target"); fs.appendFileSync(path.join(root,"cargo-calls"),args.join(" ")+"\\n"); if(args[0]==="metadata") console.log(JSON.stringify({target_directory:dir})); else {const target=args[args.indexOf("--target")+1]; const profile=args.includes("--release")?"release":"debug"; const out=path.join(dir,target,profile);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,"berd-memory-mcp"),"synthetic",{mode:0o755});}\n',
  );
  const env = {
    ...process.env,
    // Hermit's NODE_OPTIONS preload can prepend its real pnpm/cargo to PATH
    // in every child Node process. Disable it only in these synthetic fixtures.
    NODE_OPTIONS: "",
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    MOCK_HOST: MEMORY_TARGET,
    FIXTURE: root,
    CAPTURE: join(root, "capture.json"),
  };
  for (const key of [
    "CARGO_BUILD_TARGET",
    "TAURI_CONFIG",
    "TAURI_ENV_TARGET_TRIPLE",
    "TAURI_ENV_PLATFORM",
    "TAURI_ENV_ARCH",
    "BERD_MEMORY_BUILD_TARGET",
    "BERD_MEMORY_MCP_BIN",
    "VITE_MEMORY_SUPPORTED",
  ])
    delete env[key];
  function call(command, args, overrides = {}) {
    const result = spawnSync(command, args, {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    const capture = existsSync(env.CAPTURE)
      ? JSON.parse(readFileSync(env.CAPTURE, "utf8"))
      : undefined;
    return { result, capture };
  }
  return { root, env, call };
}

function finalBin(capture) {
  return JSON.parse(capture.args.at(-1)).bundle.externalBin;
}

describe("memory packaging contract", () => {
  it("keeps base/platform/dev manifests memory-free and preserves all other sidecars", () => {
    const base = JSON.parse(read("src-tauri/tauri.conf.json")).bundle
      .externalBin;
    const win = JSON.parse(read("src-tauri/tauri.windows.conf.json")).bundle
      .externalBin;
    const mac = JSON.parse(read("src-tauri/tauri.macos.conf.json"));
    const dev = JSON.parse(read("src-tauri/tauri.dev.conf.json"));
    expect(base).toEqual([
      "binaries/goosed",
      "binaries/berdctl",
      "binaries/berd-monitor",
      "binaries/catch",
    ]);
    expect(win).toEqual(base.slice(0, 3));
    expect(mac.bundle?.externalBin).toBeUndefined();
    expect(dev.bundle.externalBin).toEqual([]);
    for (const bins of [base, win, dev.bundle.externalBin])
      expect(bins).not.toContain(MEMORY_BIN);
    expect(
      memoryExternalBin(
        [...base, MEMORY_BIN, "other/berd-memory-mcp-old.exe"],
        MEMORY_TARGET,
      ),
    ).toEqual([...base, MEMORY_BIN]);
    expect(
      memoryExternalBin([...base, MEMORY_BIN], MEMORY_TARGET, "dev"),
    ).toEqual(base);
  });

  it.each([
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
  ])("filters stale overlays, staging and inherited env for %s", (target) => {
    const { root, call } = fixture();
    const bins = [
      "custom/retained",
      MEMORY_BIN,
      "binaries/berd-memory-mcp-old.exe",
    ];
    writeFileSync(
      join(root, "stale.json"),
      JSON.stringify({ bundle: { externalBin: bins } }),
    );
    for (const file of [
      "berd-memory-mcp-aarch64-apple-darwin",
      "berd-memory-mcp-old.exe",
      "goosed-retained",
    ])
      writeFileSync(join(root, "src-tauri/binaries", file), "synthetic");
    const { result, capture } = call(
      "node",
      [
        "scripts/tauri-memory.mjs",
        "build",
        "--target",
        target,
        "--config",
        "stale.json",
      ],
      {
        TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [MEMORY_BIN] } }),
        TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET,
        VITE_MEMORY_SUPPORTED: "1",
        BERD_MEMORY_MCP_BIN: "stale",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(finalBin(capture)).toEqual(["custom/retained"]);
    expect(JSON.parse(capture.env.TAURI_CONFIG).bundle.externalBin).toEqual([
      "custom/retained",
    ]);
    expect(capture.env.TAURI_ENV_TARGET_TRIPLE).toBe(target);
    expect(capture.env.CARGO_BUILD_TARGET).toBe(target);
    expect(capture.env.BERD_MEMORY_MCP_BIN).toBeUndefined();
    expect(capture.env.VITE_MEMORY_SUPPORTED).toBeUndefined();
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
    expect(readdirSync(join(root, "src-tauri/binaries"))).toEqual([
      "goosed-retained",
    ]);
  });

  it("stages the selected Apple silicon target and replaces a stale full-manifest overlay", () => {
    const { root, call } = fixture();
    const base = JSON.parse(read("src-tauri/tauri.conf.json")).bundle
      .externalBin;
    writeFileSync(
      join(root, "stale.json"),
      JSON.stringify({
        bundle: { externalBin: [...base, MEMORY_BIN, "custom/retained"] },
      }),
    );
    const { result, capture } = call(
      "node",
      [
        "scripts/tauri-memory.mjs",
        "build",
        "--target",
        MEMORY_TARGET,
        "--config",
        "stale.json",
      ],
      {
        MOCK_HOST: "x86_64-unknown-linux-gnu",
        TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(finalBin(capture)).toEqual([...base, "custom/retained", MEMORY_BIN]);
    expect(readFileSync(join(root, "cargo-calls"), "utf8")).toContain(
      `build -p berd-memory --release --target ${MEMORY_TARGET}`,
    );
    expect(
      existsSync(
        join(root, `src-tauri/binaries/berd-memory-mcp-${MEMORY_TARGET}`),
      ),
    ).toBe(true);
    expect(capture.env.TAURI_ENV_TARGET_TRIPLE).toBe(MEMORY_TARGET);
    expect(capture.env.CARGO_BUILD_TARGET).toBe(MEMORY_TARGET);
    expect(capture.env.BERD_MEMORY_BUILD_TARGET).toBe(MEMORY_TARGET);
  });

  it("builds dev memory only for the selected compile target, without bundling it", () => {
    const { root, call } = fixture();
    const { result, capture } = call("node", [
      "scripts/tauri-memory.mjs",
      "dev",
      "--target",
      MEMORY_TARGET,
      "--config",
      '{"bundle":{"externalBin":[]}}',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(finalBin(capture)).toEqual([]);
    expect(readFileSync(join(root, "cargo-calls"), "utf8")).toContain(
      `build -p berd-memory --target ${MEMORY_TARGET}`,
    );
    expect(capture.env.BERD_MEMORY_MCP_BIN).toBe(
      join(root, "cargo-target", MEMORY_TARGET, "debug/berd-memory-mcp"),
    );
    expect(readdirSync(join(root, "src-tauri/binaries"))).toEqual([]);
  });

  it("preserves native hostless Tauri output paths and Windows nonmemory bins", () => {
    const { call } = fixture();
    const { result, capture } = call(
      "node",
      ["scripts/tauri-memory.mjs", "build"],
      {
        MOCK_HOST: "x86_64-pc-windows-msvc",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(capture.args).not.toContain("--target");
    expect(finalBin(capture)).toEqual([
      "binaries/goosed",
      "binaries/berdctl",
      "binaries/berd-monitor",
    ]);
    expect(capture.env.TAURI_ENV_TARGET_TRIPLE).toBe("x86_64-pc-windows-msvc");
  });

  it("standalone staging skips unsupported targets and removes only memory files", () => {
    const { root, call } = fixture();
    for (const name of ["berd-memory-mcp-old", "berdctl-keep"])
      writeFileSync(join(root, "src-tauri/binaries", name), "synthetic");
    const { result } = call("bash", [
      "scripts/prepare-memory-sidecar.sh",
      "x86_64-apple-darwin",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "cargo-calls"))).toBe(false);
    expect(readdirSync(join(root, "src-tauri/binaries"))).toEqual([
      "berdctl-keep",
    ]);
  });

  it("rejects ambiguous compile targets before staging", () => {
    const { root, call } = fixture();
    for (const args of [
      ["--target="],
      ["--target", MEMORY_TARGET, "--target", "x86_64-apple-darwin"],
    ]) {
      const { result, capture } = call("node", [
        "scripts/tauri-memory.mjs",
        "build",
        ...args,
      ]);
      expect(result.status).not.toBe(0);
      expect(capture).toBeUndefined();
      expect(existsSync(join(root, "cargo-calls"))).toBe(false);
    }
  });

  it("routes local/release builds through the wrapper with no unconditional staging", () => {
    const justfile = read("justfile");
    const release = read("scripts/release/build-macos.sh");
    expect(JSON.parse(read("package.json")).scripts.tauri).toBe(
      "node scripts/tauri-memory.mjs",
    );
    expect(
      justfile.match(/\.\/scripts\/prepare-memory-sidecar\.sh/g),
    ).toHaveLength(1);
    expect(justfile).toContain('pnpm tauri dev --features "$CARGO_FEATURES"');
    expect(justfile).toContain(
      'pnpm tauri build --features "$CARGO_FEATURES_CSV"',
    );
    expect(release).not.toContain(
      './scripts/prepare-memory-sidecar.sh "$TARGET_TRIPLE"',
    );
    expect(release).toContain(
      'pnpm tauri build --no-sign --target "$TARGET_TRIPLE"',
    );
    expect(read("scripts/windows/Stage-Sidecar-Windows.ps1")).not.toContain(
      '"-p", "berd-memory"',
    );
    expect(read("scripts/windows/Stage-Sidecar-Windows.ps1")).toContain(
      '"berd-memory-mcp*"',
    );
  });
});

describe("Vite compile target", () => {
  it("derives support only from a matching target triple", () => {
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_PLATFORM: "darwin",
        TAURI_ENV_ARCH: "aarch64",
      }),
    ).toBe(false);
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin",
        VITE_MEMORY_SUPPORTED: "1",
      }),
    ).toBe(false);
    expect(
      isMemoryTargetSupported({
        TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET,
        VITE_MEMORY_SUPPORTED: "0",
      }),
    ).toBe(true);
  });
  it.each([
    [{ VITE_MEMORY_SUPPORTED: "1" }, "0"],
    [
      {
        TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin",
        TAURI_ENV_PLATFORM: "darwin",
        TAURI_ENV_ARCH: "aarch64",
        VITE_MEMORY_SUPPORTED: "1",
      },
      "0",
    ],
    [
      {
        TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET,
        BERD_MEMORY_BUILD_TARGET: MEMORY_TARGET,
        VITE_MEMORY_SUPPORTED: "0",
      },
      "1",
    ],
  ])("defines VITE_MEMORY_SUPPORTED for compile target %j", (overrides, expected) => {
    const env = { ...process.env };
    for (const key of [
      "TAURI_ENV_TARGET_TRIPLE",
      "TAURI_ENV_PLATFORM",
      "TAURI_ENV_ARCH",
      "BERD_MEMORY_BUILD_TARGET",
      "VITE_MEMORY_SUPPORTED",
    ])
      delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {loadConfigFromFile} from "vite"; const c = await loadConfigFromFile({command:"build",mode:"production"},"vite.config.ts"); console.log(c.config.define["import.meta.env.VITE_MEMORY_SUPPORTED"]);',
      ],
      {
        cwd: repo,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toBe(expected);
  });
  it("rejects supported Vite builds outside the staging wrapper", () => {
    const env = { ...process.env, TAURI_ENV_TARGET_TRIPLE: MEMORY_TARGET };
    delete env.BERD_MEMORY_BUILD_TARGET;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {loadConfigFromFile} from "vite"; await loadConfigFromFile({command:"build",mode:"production"},"vite.config.ts");',
      ],
      { cwd: repo, env, encoding: "utf8", timeout: 10000 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("prepare the matching sidecar");
  });
});
