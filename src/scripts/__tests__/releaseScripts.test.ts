import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const releaseConfigScript = resolve(
  repoRoot,
  "scripts/build-tauri-release-config.mjs",
);
const publishUpdaterScript = resolve(
  repoRoot,
  "scripts/publish-updater-to-artifactory.sh",
);
const releaseMacosDir = resolve(repoRoot, "release/macos");
const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "goose-release-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeReleaseArtifacts() {
  mkdirSync(releaseMacosDir, { recursive: true });
  writeFileSync(resolve(releaseMacosDir, "Goose.app.tar.gz"), "archive");
  writeFileSync(resolve(releaseMacosDir, "Goose.app.tar.gz.sig"), "signature");
}

function makeFakeCurl() {
  const dir = makeTempDir();
  const logPath = resolve(dir, "curl.log");
  const curlPath = resolve(dir, "curl");
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
src=""
url="\${@: -1}"
while (($#)); do
  case "$1" in
    -T)
      src="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
{
  printf '%s\\t%s\\n' "$(basename "$src")" "$url"
  cat "$src"
  printf '\\n---END---\\n'
} >> "$CURL_LOG"
`,
  );
  chmodSync(curlPath, 0o755);
  return { binDir: dir, logPath };
}

function readCurlUploads(logPath: string) {
  return readFileSync(logPath, "utf8")
    .trim()
    .split(/\n---END---\n?/)
    .filter(Boolean)
    .map((entry) => {
      const firstNewline = entry.indexOf("\n");
      const header = firstNewline === -1 ? entry : entry.slice(0, firstNewline);
      const body = firstNewline === -1 ? "" : entry.slice(firstNewline + 1);
      const [filename, url] = header.split("\t");
      return { filename, url, body };
    });
}

describe("release scripts", () => {
  afterEach(() => {
    rmSync(resolve(releaseMacosDir, "Goose.app.tar.gz"), { force: true });
    rmSync(resolve(releaseMacosDir, "Goose.app.tar.gz.sig"), { force: true });
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("fails release config generation when updater env is missing", () => {
    const outPath = resolve(makeTempDir(), "tauri.release.conf.json");

    expect(() =>
      execFileSync(process.execPath, [releaseConfigScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          GOOSE2_UPDATER_ENDPOINT: "",
          GOOSE2_UPDATER_PUBLIC_KEY: "",
          TAURI_RELEASE_CONFIG_PATH: outPath,
        },
        stdio: "pipe",
      }),
    ).toThrow();
    expect(existsSync(outPath)).toBe(false);
  });

  it("writes only the updater release config overlay", () => {
    const outPath = resolve(makeTempDir(), "tauri.release.conf.json");

    execFileSync(process.execPath, [releaseConfigScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GOOSE2_UPDATER_ENDPOINT: "https://example.com/latest.json",
        GOOSE2_UPDATER_PUBLIC_KEY: "public-key",
        TAURI_RELEASE_CONFIG_PATH: outPath,
      },
      stdio: "pipe",
    });

    const config = JSON.parse(readFileSync(outPath, "utf8"));
    expect(config).toEqual({
      plugins: {
        updater: {
          endpoints: ["https://example.com/latest.json"],
          pubkey: "public-key",
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("createUpdaterArtifacts");
  });

  it("uploads versioned updater artifacts without latest promotion", () => {
    writeReleaseArtifacts();
    const fakeCurl = makeFakeCurl();

    const stdout = execFileSync("bash", [publishUpdaterScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACTORY_BASE: "https://example.com/artifactory/mdx/goose-internal",
        CURL_LOG: fakeCurl.logPath,
        MOBUILD_ARTIFACTORY_UPLOAD_TOKEN: "token",
        PATH: `${fakeCurl.binDir}:${process.env.PATH ?? ""}`,
        PUBLISH_LATEST: "false",
        VERSION: "1.2.3",
      },
      stdio: "pipe",
    });

    expect(readCurlUploads(fakeCurl.logPath)).toEqual([
      {
        body: "archive",
        filename: "Goose.app.tar.gz",
        url: "https://example.com/artifactory/mdx/goose-internal/v1.2.3/Goose.app.tar.gz",
      },
      {
        body: "signature",
        filename: "Goose.app.tar.gz.sig",
        url: "https://example.com/artifactory/mdx/goose-internal/v1.2.3/Goose.app.tar.gz.sig",
      },
    ]);
    expect(stdout).toContain(
      "Skipping latest.json (publish_latest=false) - existing installs stay on their current version",
    );
    expect(stdout).toContain(
      "Archive still available at https://example.com/artifactory/mdx/goose-internal/v1.2.3/Goose.app.tar.gz for manual download",
    );
  });

  it("uploads latest.json with a darwin-aarch64 manifest when promoted", () => {
    writeReleaseArtifacts();
    const fakeCurl = makeFakeCurl();

    execFileSync("bash", [publishUpdaterScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACTORY_BASE: "https://example.com/artifactory/mdx/goose-internal",
        CURL_LOG: fakeCurl.logPath,
        MOBUILD_ARTIFACTORY_UPLOAD_TOKEN: "token",
        PATH: `${fakeCurl.binDir}:${process.env.PATH ?? ""}`,
        PUBLISH_LATEST: "true",
        VERSION: "1.2.3",
      },
      stdio: "pipe",
    });

    const uploads = readCurlUploads(fakeCurl.logPath);
    expect(uploads.map((upload) => upload.filename)).toEqual([
      "Goose.app.tar.gz",
      "Goose.app.tar.gz.sig",
      expect.stringMatching(/^tmp/),
    ]);
    expect(uploads[2].url).toBe(
      "https://example.com/artifactory/mdx/goose-internal/latest.json",
    );
    const manifest = JSON.parse(uploads[2].body);
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: "signature",
      url: "https://example.com/artifactory/mdx/goose-internal/v1.2.3/Goose.app.tar.gz",
    });
    expect(manifest.pub_date).toEqual(expect.stringMatching(/Z$/));
  });
});
