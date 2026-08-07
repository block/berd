#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultLockFile = path.join(repoRoot, "node-runtime.lock.json");

// Block's Artifactory `nodejs` repo is a read-through mirror of
// https://nodejs.org/dist with an identical path shape, so SHASUMS256.txt is
// the official Node.js checksum file either way.
const DEFAULT_BASE_URL =
  "https://global.block-artifacts.com/artifactory/nodejs";

// The rust target triples Berd releases for, mapped to the platform
// component of Node's release tarball names.
const TARGET_PLATFORMS = {
  "aarch64-apple-darwin": "darwin-arm64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-pc-windows-msvc": "win-x64",
  "x86_64-unknown-linux-gnu": "linux-x64",
};

// Node publishes Windows releases as `.zip` and every other platform as
// `.tar.gz`; the archive extension is keyed off the platform component.
function archiveExtension(platform) {
  return platform.startsWith("win-") ? "zip" : "tar.gz";
}

function usage() {
  console.log(`Usage: scripts/update-node-runtime-lock.mjs [version] [--lock-file <path>] [--base-url <url>]

Fetches the official SHASUMS256.txt for a Node.js release and rewrites
node-runtime.lock.json with the tarball pins for all supported targets.
Without a version argument, the currently locked version is re-resolved
(a checksum refresh).

Supported targets:
  ${Object.keys(TARGET_PLATFORMS).join("\n  ")}

Environment:
  NODE_RUNTIME_LOCK_FILE  lockfile path override
`);
}

function normalizeVersion(value) {
  const version = value.startsWith("v") ? value : `v${value}`;
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Node.js version: ${value}`);
  }
  return version;
}

function parseArgs(argv) {
  let version = null;
  let lockFile = process.env.NODE_RUNTIME_LOCK_FILE ?? defaultLockFile;
  let baseUrl = DEFAULT_BASE_URL;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--lock-file") {
      const value = argv[++i];
      if (!value) throw new Error("--lock-file requires a value");
      lockFile = path.resolve(value);
      continue;
    }
    if (arg === "--base-url") {
      const value = argv[++i];
      if (!value) throw new Error("--base-url requires a value");
      baseUrl = value.replace(/\/+$/, "");
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (version !== null) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    version = normalizeVersion(arg);
  }
  return { version, lockFile, baseUrl };
}

async function currentLockedVersion(lockFile) {
  let raw;
  try {
    raw = await readFile(lockFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return normalizeVersion(JSON.parse(raw).version);
}

async function fetchShasums(baseUrl, version) {
  const url = `${baseUrl}/${version}/SHASUMS256.txt`;
  const response = await fetch(url, {
    headers: { "User-Agent": "berd-node-runtime-lock" },
  });
  if (!response.ok) {
    throw new Error(
      `Fetch failed: ${url} (${response.status} ${response.statusText})`,
    );
  }
  const shasums = new Map();
  for (const line of (await response.text()).split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (match) shasums.set(match[2], match[1]);
  }
  if (shasums.size === 0) {
    throw new Error(`No checksums parsed from ${url}`);
  }
  return shasums;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version ?? (await currentLockedVersion(args.lockFile));
  if (!version) {
    throw new Error(
      "No version given and no existing lockfile to refresh; pass a version (e.g. v24.11.0)",
    );
  }

  const shasums = await fetchShasums(args.baseUrl, version);
  const artifacts = {};
  for (const [target, platform] of Object.entries(TARGET_PLATFORMS)) {
    const filename = `node-${version}-${platform}.${archiveExtension(platform)}`;
    const sha256 = shasums.get(filename);
    if (!sha256) {
      throw new Error(
        `SHASUMS256.txt for ${version} has no entry for ${filename}`,
      );
    }
    artifacts[target] = { filename, sha256 };
  }

  await writeFile(
    args.lockFile,
    `${JSON.stringify({ version, artifacts }, null, 2)}\n`,
  );
  console.log(
    `Updated ${path.relative(process.cwd(), args.lockFile)} to Node.js ${version}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
