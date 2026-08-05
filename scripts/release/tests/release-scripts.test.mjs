import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../../..");
const tempDirs = [];

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "berd-release-test-"));
  tempDirs.push(path);
  return path;
}

function run(command, args, env = {}) {
  return spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("build-tauri-release-config", () => {
  async function generate(env) {
    const dir = await tempDir();
    const output = join(dir, "release.json");
    const result = run(
      "node",
      ["scripts/release/build-tauri-release-config.mjs"],
      {
        BERD_RELEASE_CHANNEL: "",
        BERD_UPDATER_ENDPOINT: "",
        BERD_UPDATER_PUBLIC_KEY: "",
        ...env,
        TAURI_RELEASE_CONFIG_PATH: output,
      },
    );
    return { result, output };
  }

  it.each([
    "public",
    "internal",
  ])("emits one endpoint/key pair for %s", async (channel) => {
    const { result, output } = await generate({
      BERD_RELEASE_CHANNEL: channel,
      BERD_UPDATER_ENDPOINT: "https://updates.example.test/latest.json",
      BERD_UPDATER_PUBLIC_KEY: `${channel}-key`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      plugins: {
        updater: {
          pubkey: `${channel}-key`,
          endpoints: ["https://updates.example.test/latest.json"],
        },
      },
    });
  });

  it("emits an empty overlay for disabled", async () => {
    const { result, output } = await generate({
      BERD_RELEASE_CHANNEL: "disabled",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({});
  });

  it.each([
    ["missing channel", {}],
    ["unknown channel", { BERD_RELEASE_CHANNEL: "stable" }],
    [
      "missing endpoint",
      { BERD_RELEASE_CHANNEL: "public", BERD_UPDATER_PUBLIC_KEY: "key" },
    ],
    [
      "missing key",
      {
        BERD_RELEASE_CHANNEL: "internal",
        BERD_UPDATER_ENDPOINT: "https://example.test/latest.json",
      },
    ],
    [
      "non-HTTPS endpoint",
      {
        BERD_RELEASE_CHANNEL: "public",
        BERD_UPDATER_PUBLIC_KEY: "key",
        BERD_UPDATER_ENDPOINT: "http://example.test/latest.json",
      },
    ],
    [
      "credentials in endpoint",
      {
        BERD_RELEASE_CHANNEL: "public",
        BERD_UPDATER_PUBLIC_KEY: "key",
        BERD_UPDATER_ENDPOINT: "https://user@example.test/latest.json",
      },
    ],
    [
      "disabled mixed with key",
      { BERD_RELEASE_CHANNEL: "disabled", BERD_UPDATER_PUBLIC_KEY: "key" },
    ],
    [
      "disabled mixed with endpoint",
      {
        BERD_RELEASE_CHANNEL: "disabled",
        BERD_UPDATER_ENDPOINT: "https://example.test/latest.json",
      },
    ],
  ])("fails closed for %s", async (_name, env) => {
    const { result } = await generate(env);
    expect(result.status).not.toBe(0);
  });
});

describe("generate-latest-json", () => {
  it("generates an architecture-qualified manifest", async () => {
    const dir = await tempDir();
    const signature = join(dir, "archive.sig");
    await writeFile(signature, "signed-value\n");
    const result = run("scripts/release/generate-latest-json.sh", [
      "1.2.3",
      "darwin-aarch64",
      signature,
      "https://github.com/squareup/berd/releases/download/berd-desktop-latest/Berd_1.2.3_darwin-aarch64.app.tar.gz",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "1.2.3",
      platforms: {
        "darwin-aarch64": {
          signature: "signed-value",
          url: "https://github.com/squareup/berd/releases/download/berd-desktop-latest/Berd_1.2.3_darwin-aarch64.app.tar.gz",
        },
      },
    });
  });
});

describe("package-signed-updater", () => {
  it("uses the version/platform-qualified filename and keeps Berd.app at archive root", async () => {
    const dir = await tempDir();
    const app = join(dir, "Berd.app");
    const zip = join(dir, "Berd.app.zip");
    const output = join(dir, "output");
    const fakeBin = join(dir, "bin");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(join(app, "Contents", "marker"), "signed app");
    expect(run("ditto", ["-c", "-k", "--keepParent", app, zip]).status).toBe(0);
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
archive="\${@: -1}"
printf fake-signature > "$archive.sig"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(fakeBin, "cargo"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"updater-signature-verifier"* ]]
`,
      { mode: 0o755 },
    );

    const result = run(
      "scripts/release/package-signed-updater.sh",
      [
        "--app-zip",
        zip,
        "--version",
        "1.2.3",
        "--platform",
        "darwin-aarch64",
        "--output-dir",
        output,
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        TAURI_SIGNING_PRIVATE_KEY: "test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-password",
        BERD_UPDATER_PUBLIC_KEY: "test-public-key",
        SKIP_MACOS_SECURITY_CHECKS: "1",
        CI: "",
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const archive = join(output, "Berd_1.2.3_darwin-aarch64.app.tar.gz");
    const listing = run("tar", ["-tzf", archive]);
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout.split("\n")[0]).toBe("Berd.app/");
    expect(await readFile(`${archive}.sig`, "utf8")).toBe("fake-signature");
    expect(await readFile(`${archive}.sha256`, "utf8")).toContain(
      "Berd_1.2.3_darwin-aarch64.app.tar.gz",
    );
  });
});

describe("upload-immutable-assets", () => {
  async function fixture(existingAssets = {}) {
    const dir = await tempDir();
    const remote = join(dir, "remote");
    const bin = join(dir, "bin");
    const assetDir = join(dir, "assets");
    const calls = join(dir, "calls");
    await mkdir(remote);
    await mkdir(bin);
    await mkdir(assetDir);
    for (const [name, contents] of Object.entries(existingAssets)) {
      await writeFile(join(remote, name), contents);
    }
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
[[ "$1 $2" == "release download" || "$1 $2" == "release upload" || "$1" == "api" ]]
if [[ "$1" == "api" ]]; then
  for path in "$REMOTE"/*; do
    [[ -f "$path" ]] && basename "$path"
  done
elif [[ "$2" == "download" ]]; then
  output=""
  pattern=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) output="$2"; shift 2 ;;
      --pattern) pattern="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  # Reproduce gh's real refusal so a mktemp-created output regresses this test.
  [[ ! -e "$output" ]] || { echo "$output already exists" >&2; exit 1; }
  [[ -f "$REMOTE/$pattern" ]] || exit 1
  cp "$REMOTE/$pattern" "$output"
else
  asset="\${@: -1}"
  cp "$asset" "$REMOTE/$(basename "$asset")"
fi
`,
      { mode: 0o755 },
    );
    return { dir, remote, bin, assetDir, calls };
  }

  function upload(fixture, assets) {
    return run(
      "scripts/release/github/upload-immutable-assets.sh",
      ["squareup/berd", "v1.2.3", ...assets],
      {
        PATH: `${fixture.bin}:${process.env.PATH}`,
        REMOTE: fixture.remote,
        CALLS: fixture.calls,
      },
    );
  }

  it("downloads an existing asset to an absent path and accepts identical bytes", async () => {
    const f = await fixture({ "archive.tar.gz": "same" });
    const asset = join(f.assetDir, "archive.tar.gz");
    await writeFile(asset, "same");
    const result = upload(f, [asset]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("verified existing immutable asset");
    expect(await readFile(f.calls, "utf8")).not.toContain("release upload");
  });

  it("rejects an existing asset with conflicting bytes", async () => {
    const f = await fixture({ "archive.tar.gz": "old" });
    const asset = join(f.assetDir, "archive.tar.gz");
    await writeFile(asset, "new");
    const result = upload(f, [asset]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("different bytes");
    expect(await readFile(f.calls, "utf8")).not.toContain("release upload");
  });

  it("fills only missing assets in a partially staged release", async () => {
    const f = await fixture({ "existing.tar.gz": "same" });
    const existing = join(f.assetDir, "existing.tar.gz");
    const missing = join(f.assetDir, "missing.tar.gz");
    await writeFile(existing, "same");
    await writeFile(missing, "new");
    const result = upload(f, [existing, missing]);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(f.remote, "missing.tar.gz"), "utf8")).toBe(
      "new",
    );
    const calls = await readFile(f.calls, "utf8");
    expect(calls.match(/^release upload.*$/gm)).toHaveLength(1);
    expect(calls).toContain(missing);
  });
});

describe("verify-release-ref", () => {
  it("binds HEAD, a local tag, and the canonical remote tag", async () => {
    const dir = await tempDir();
    const remote = join(dir, "remote.git");
    const checkout = join(dir, "checkout");
    expect(run("git", ["init", "--bare", remote]).status).toBe(0);
    expect(run("git", ["init", checkout]).status).toBe(0);
    const git = (args) =>
      spawnSync("git", args, {
        cwd: checkout,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    expect(git(["config", "user.name", "Release Test"]).status).toBe(0);
    expect(git(["config", "user.email", "release@example.test"]).status).toBe(
      0,
    );
    await writeFile(join(checkout, "source"), "immutable");
    expect(git(["add", "source"]).status).toBe(0);
    expect(git(["commit", "-m", "source"]).status).toBe(0);
    expect(git(["tag", "--no-sign", "v1.2.3"]).status).toBe(0);
    expect(git(["remote", "add", "origin", remote]).status).toBe(0);
    expect(git(["push", "origin", "HEAD", "refs/tags/v1.2.3"]).status).toBe(0);

    const result = spawnSync(
      resolve(repo, "scripts/release/github/verify-release-ref.sh"),
      ["v1.2.3"],
      {
        cwd: checkout,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    await writeFile(join(checkout, "source"), "moved");
    expect(git(["add", "source"]).status).toBe(0);
    expect(git(["commit", "-m", "moved"]).status).toBe(0);
    const mismatch = spawnSync(
      resolve(repo, "scripts/release/github/verify-release-ref.sh"),
      ["v1.2.3"],
      {
        cwd: checkout,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match");
  });
});

describe("verify-versioned-release", () => {
  async function fixture({ missing = "", tagSha = "a".repeat(40) } = {}) {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    await mkdir(bin);
    const names = [
      "Berd_1.2.3_darwin-aarch64.app.zip",
      "Berd_1.2.3_darwin-aarch64.dmg",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz.sig",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz.sha256",
    ].filter((name) => name !== missing);
    const release = join(dir, "release.json");
    await writeFile(release, "placeholder");
    const releaseJson = JSON.stringify({
      tagName: "v1.2.3",
      isDraft: false,
      assets: names.map((name) => ({ name, size: 1 })),
    });
    const releaseJsonBase64 = Buffer.from(releaseJson).toString("base64");
    const calls = join(dir, "gh-calls");
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALLS"
if [[ "$1 $2" == "release view" ]]; then
  printf %s "$RELEASE_JSON_BASE64" | base64 --decode
elif [[ "$1" == "api" && "$2" == */git/ref/tags/* ]]; then
  case "$*" in
    *object.type*) printf commit ;;
    *) printf %s "$TAG_SHA" ;;
  esac
else
  exit 1
fi
`,
      { mode: 0o755 },
    );
    return { bin, release, releaseJsonBase64, tagSha, calls };
  }

  function verify(f) {
    return run(
      "scripts/release/github/verify-versioned-release.sh",
      ["v1.2.3", "a".repeat(40)],
      {
        PATH: `${f.bin}:${process.env.PATH}`,
        RELEASE_JSON: f.release,
        RELEASE_JSON_BASE64: f.releaseJsonBase64,
        TAG_SHA: f.tagSha,
        GH_CALLS: f.calls,
        GH_PAGER: "/bin/cat",
        PAGER: "/bin/cat",
        GH_TOKEN: "test-token",
        REPOSITORY: "squareup/berd",
        VERSION: "1.2.3",
        PLATFORM: "darwin-aarch64",
      },
    );
  }

  it("accepts one non-empty copy of every expected immutable asset", async () => {
    const f = await fixture();
    const result = verify(f);
    expect(
      result.status,
      `${result.stderr}\n${await readFile(f.calls, "utf8")}`,
    ).toBe(0);
  });

  it("rejects an incomplete staged asset set", async () => {
    const result = verify(
      await fixture({ missing: "Berd_1.2.3_darwin-aarch64.app.tar.gz.sig" }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exactly one non-empty asset");
  });

  it("rejects a release whose remote tag moved", async () => {
    const result = verify(await fixture({ tagSha: "b".repeat(40) }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected");
  });
});

describe("promote-public-updater", () => {
  async function fixture({
    publicDigestMatches = true,
    signatureValid = true,
  } = {}) {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    const staged = join(dir, "staged");
    const calls = join(dir, "calls");
    await mkdir(bin);
    await mkdir(join(staged, "Berd.app", "Contents"), { recursive: true });
    await writeFile(join(staged, "Berd.app", "Contents", "marker"), "signed");
    const archive = join(dir, "Berd_1.2.3_darwin-aarch64.app.tar.gz");
    expect(
      spawnSync("tar", ["-C", staged, "-czf", archive, "Berd.app"]).status,
    ).toBe(0);
    await writeFile(`${archive}.sig`, "signature");
    const digest = run("shasum", ["-a", "256", archive]).stdout.split(/\s+/)[0];
    await writeFile(
      `${archive}.sha256`,
      `${digest}  ${archive.split("/").at(-1)}\n`,
    );
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1 $2" == "release download" ]]; then
  dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --dir) dir="$2"; shift 2 ;; *) shift ;; esac
  done
  cp "$STAGED_ARCHIVE" "$STAGED_ARCHIVE.sig" "$STAGED_ARCHIVE.sha256" "$dir/"
elif [[ "$1 $2" == "release view" ]]; then
  exit 0
elif [[ "$1 $2" == "release upload" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == */latest.json ]]; then cp "$arg" "$PUBLISHED_MANIFEST"; fi
  done
else
  exit 1
fi
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "cargo"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"updater-signature-verifier"* ]]
[[ "$SIGNATURE_VALID" == true ]]
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in -o) output="$2"; shift 2 ;; *) shift ;; esac
done
if [[ "$output" == *published-latest.json ]]; then
  cp "$PUBLISHED_MANIFEST" "$output"
elif [[ "$PUBLIC_DIGEST_MATCHES" == true ]]; then
  cp "$STAGED_ARCHIVE" "$output"
else
  printf tampered > "$output"
fi
`,
      { mode: 0o755 },
    );
    const channelConfig = join(dir, "public-channel.json");
    await writeFile(
      channelConfig,
      JSON.stringify({
        repository: "squareup/berd",
        rollingTag: "berd-desktop-latest",
        platform: "darwin-aarch64",
      }),
    );
    return {
      dir,
      bin,
      archive,
      calls,
      channelConfig,
      publicDigestMatches,
      signatureValid,
      publishedManifest: join(dir, "published-latest.json"),
    };
  }

  function promote(f) {
    return run(
      "scripts/release/github/promote-public-updater.sh",
      ["v1.2.3", "a".repeat(40), join(f.dir, "summary.md")],
      {
        PATH: `${f.bin}:${process.env.PATH}`,
        GH_TOKEN: "test-token",
        BERD_PUBLIC_UPDATER_PUBLIC_KEY: "test-public-key",
        GITHUB_REPOSITORY: "squareup/berd",
        STAGED_ARCHIVE: f.archive,
        CALLS: f.calls,
        PUBLISHED_MANIFEST: f.publishedManifest,
        PUBLIC_DIGEST_MATCHES: String(f.publicDigestMatches),
        SIGNATURE_VALID: String(f.signatureValid),
        BERD_PROMOTION_RETRY_DELAY_SECONDS: "0",
        BERD_PUBLIC_CHANNEL_CONFIG: f.channelConfig,
      },
    );
  }

  it("uploads latest.json only after public archive verification", async () => {
    const f = await fixture();
    const result = promote(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = (await readFile(f.calls, "utf8")).trim().split("\n");
    expect(calls.at(-1)).toContain("latest.json");
    expect(
      JSON.parse(await readFile(f.publishedManifest, "utf8")).version,
    ).toBe("1.2.3");
  });

  it("rejects an invalid updater signature before mutating the rolling release", async () => {
    const f = await fixture({ signatureValid: false });
    const result = promote(f);
    expect(result.status).not.toBe(0);
    const calls = await readFile(f.calls, "utf8");
    expect(calls).not.toContain("release upload");
  });

  it("leaves latest.json untouched when anonymous bytes do not match", async () => {
    const f = await fixture({ publicDigestMatches: false });
    const result = promote(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not publicly accessible");
    const calls = await readFile(f.calls, "utf8");
    expect(calls).not.toContain("latest.json");
  });
});
