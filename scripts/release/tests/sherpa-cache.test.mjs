import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../../..");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const libraries = [
  "sherpa-onnx-c-api",
  "sherpa-onnx-core",
  "kaldi-decoder-core",
  "sherpa-onnx-kaldifst-core",
  "sherpa-onnx-fstfar",
  "sherpa-onnx-fst",
  "kaldi-native-fbank-core",
  "kissfft-float",
  "piper_phonemize",
  "espeak-ng",
  "ucd",
  "onnxruntime",
  "ssentencepiece_core",
];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "berd-sherpa-repair-")));
  roots.push(root);
  for (const dir of [
    "scripts",
    "src-tauri",
    "bin",
    "resolved cargo target/sherpa-onnx-prebuilt",
  ])
    mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(
    join(repo, "scripts/repair-sherpa-cache.py"),
    join(root, "scripts/repair-sherpa-cache.py"),
  );
  writeFileSync(
    join(root, "src-tauri/Cargo.lock"),
    '[[package]]\nname = "sherpa-onnx-sys"\nversion = "1.12.40"\n',
  );
  writeFileSync(join(root, "src-tauri/Cargo.toml"), "# synthetic\n");
  writeFileSync(
    join(root, "bin/cargo"),
    `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.CLEAN_EXIT||0));`,
    { mode: 0o755 },
  );
  const target = join(root, "resolved cargo target");
  const cache = join(target, "sherpa-onnx-prebuilt");
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    CAPTURE: join(root, "cargo.json"),
  };
  delete env.SHERPA_ONNX_LIB_DIR;
  const run = (extra = {}) =>
    spawnSync("python3", ["scripts/repair-sherpa-cache.py", target], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  function extraction(platform, healthy = false) {
    const dir = join(cache, `sherpa-onnx-v1.12.40-${platform}-static-lib`);
    mkdirSync(join(dir, "lib"), { recursive: true });
    if (healthy)
      for (const name of libraries)
        writeFileSync(join(dir, "lib", `lib${name}.a`), "synthetic library");
    return dir;
  }
  return { root, target, cache, env, run, extraction };
}

describe("narrow Sherpa cache repair", () => {
  it.each([
    "osx-arm64",
    "osx-x64",
    "linux-x64",
    "linux-aarch64",
  ])("repairs a restored empty %s extraction and invalidates only its owning package", (platform) => {
    const f = fixture();
    const broken = f.extraction(platform);
    const archive = `${broken}.tar.bz2`;
    writeFileSync(archive, "retained archive");
    const unrelated = join(f.target, "unrelated-output");
    writeFileSync(unrelated, "keep");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(broken)).toBe(false);
    expect(existsSync(archive)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(JSON.parse(readFileSync(f.env.CAPTURE, "utf8"))).toEqual([
      "clean",
      "--frozen",
      "--manifest-path",
      join(f.root, "src-tauri/Cargo.toml"),
      "--target-dir",
      f.target,
      "-p",
      "sherpa-onnx-sys",
    ]);
  });
  it("preserves every healthy extraction and does not clean Cargo", () => {
    const f = fixture();
    const healthy = f.extraction("osx-arm64", true);
    expect(f.run().status).toBe(0);
    expect(existsSync(healthy)).toBe(true);
    expect(existsSync(f.env.CAPTURE)).toBe(false);
  });
  it("detects a partially stripped library set but preserves a healthy other target", () => {
    const f = fixture();
    const broken = f.extraction("osx-arm64", true);
    const healthy = f.extraction("linux-x64", true);
    rmSync(join(broken, "lib/libonnxruntime.a"));
    expect(f.run().status).toBe(0);
    expect(existsSync(broken)).toBe(false);
    expect(existsSync(healthy)).toBe(true);
  });
  it("does not clean user-provided libraries or follow cache symlinks", () => {
    const f = fixture();
    const broken = f.extraction("osx-arm64");
    expect(f.run({ SHERPA_ONNX_LIB_DIR: "/synthetic/custom" }).status).toBe(0);
    expect(existsSync(broken)).toBe(true);
    const link = join(f.cache, "sherpa-onnx-v1.12.40-linux-x64-static-lib");
    symlinkSync(broken, link);
    expect(f.run().status).not.toBe(0);
    expect(existsSync(broken)).toBe(true);
    expect(existsSync(f.env.CAPTURE)).toBe(false);
  });
  it("surfaces clean failures and leaves evidence for a retry", () => {
    const f = fixture();
    const broken = f.extraction("osx-arm64");
    expect(f.run({ CLEAN_EXIT: "1" }).status).not.toBe(0);
    expect(existsSync(broken)).toBe(true);
  });
  it("repairs before each Unix Cargo gate with its actual resolved target instead of unconditional Linux deletion", () => {
    const justfile = readFileSync(join(repo, "justfile"), "utf8");
    expect(justfile).toContain(
      'cd src-tauri && python3 ../scripts/repair-sherpa-cache.py "$TAURI_CARGO_TARGET_DIR"',
    );
    expect(justfile).not.toContain(
      "rm -rf src-tauri/target/sherpa-onnx-prebuilt",
    );
    expect(justfile).toContain("_tauri-cargo-unix *ARGS:");
  });
});
