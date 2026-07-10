#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultLockFile = path.join(repoRoot, "acp-tools.lock.json");

const SUPPORTED_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
];

// The Codex ACP executable stays `codex-acp`, but new bundled installs should
// come from the maintained Agent Client Protocol package rather than the stale
// Zed package.
const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";

const TOOL_SPECS = [
  {
    id: "claude-acp",
    binary: "claude-agent-acp",
    source: "npm",
    package: "@agentclientprotocol/claude-agent-acp",
    dependencyPackage: "@anthropic-ai/claude-agent-sdk",
    nativePackageKey: "claudeAgentSdk",
    includeClaudeCodeVersion: true,
  },
  {
    id: "codex-acp",
    binary: "codex-acp",
    source: "npm",
    package: CODEX_ACP_PACKAGE,
    dependencyPackage: "@openai/codex",
    nativePackageKey: "openaiCodex",
  },
];

const NPM_TARGET_CONFIG = {
  "aarch64-apple-darwin": {
    npmOs: "darwin",
    npmCpu: "arm64",
    nativePackages: {
      claudeAgentSdk: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      openaiCodex: "@openai/codex-darwin-arm64",
    },
    nativeExecutables: {
      claudeAgentSdk: "claude",
      openaiCodex: "vendor/aarch64-apple-darwin/bin/codex",
    },
  },
  "x86_64-apple-darwin": {
    npmOs: "darwin",
    npmCpu: "x64",
    nativePackages: {
      claudeAgentSdk: "@anthropic-ai/claude-agent-sdk-darwin-x64",
      openaiCodex: "@openai/codex-darwin-x64",
    },
    nativeExecutables: {
      claudeAgentSdk: "claude",
      openaiCodex: "vendor/x86_64-apple-darwin/bin/codex",
    },
  },
  "aarch64-unknown-linux-gnu": {
    npmOs: "linux",
    npmCpu: "arm64",
    npmLibc: "glibc",
    nativePackages: {
      claudeAgentSdk: "@anthropic-ai/claude-agent-sdk-linux-arm64",
      openaiCodex: "@openai/codex-linux-arm64",
    },
    nativeExecutables: {
      claudeAgentSdk: "claude",
      openaiCodex: "vendor/aarch64-unknown-linux-musl/bin/codex",
    },
  },
  "x86_64-unknown-linux-gnu": {
    npmOs: "linux",
    npmCpu: "x64",
    npmLibc: "glibc",
    nativePackages: {
      claudeAgentSdk: "@anthropic-ai/claude-agent-sdk-linux-x64",
      openaiCodex: "@openai/codex-linux-x64",
    },
    nativeExecutables: {
      claudeAgentSdk: "claude",
      openaiCodex: "vendor/x86_64-unknown-linux-musl/bin/codex",
    },
  },
};

const releaseCache = new Map();
const npmViewCache = new Map();
const execFileAsync = promisify(execFile);

const TARGET_PATTERNS = {
  "aarch64-apple-darwin": {
    include: ["darwin", "mac", "macos", "aarch64", "arm64"],
    arch: ["aarch64", "arm64"],
    os: ["darwin", "mac", "macos"],
    exclude: ["x64", "x86_64", "linux", "windows", ".exe"],
  },
  "x86_64-apple-darwin": {
    include: ["darwin", "mac", "macos", "x64", "x86_64"],
    arch: ["x64", "x86_64"],
    os: ["darwin", "mac", "macos"],
    exclude: ["aarch64", "arm64", "linux", "windows", ".exe"],
  },
  "aarch64-unknown-linux-gnu": {
    include: ["linux", "aarch64", "arm64"],
    arch: ["aarch64", "arm64"],
    os: ["linux"],
    exclude: ["x64", "x86_64", "darwin", "macos", "musl", "windows", ".exe"],
  },
  "x86_64-unknown-linux-gnu": {
    include: ["linux", "x64", "x86_64"],
    arch: ["x64", "x86_64"],
    os: ["linux"],
    exclude: ["aarch64", "arm64", "darwin", "macos", "musl", "windows", ".exe"],
  },
};

function usage() {
  console.log(`Usage: scripts/update-acp-tools-lock.mjs [--target <triple>]... [--lock-file <path>]

Queries package sources for supported ACP bridge tools and writes
acp-tools.lock.json. GitHub-sourced tools require the latest stable release to
include a per-target binary asset. NPM-sourced tools lock package metadata and
the target native dependency metadata used during resource preparation.

Supported targets:
  ${SUPPORTED_TARGETS.join("\n  ")}

Environment:
  GITHUB_TOKEN            optional GitHub API token
  npm registry config     used for npm-sourced tools
  ACP_TOOLS_LOCK_FILE     lockfile path override
`);
}

function parseArgs(argv) {
  const targets = [];
  let lockFile = process.env.ACP_TOOLS_LOCK_FILE ?? defaultLockFile;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--target") {
      const value = argv[++i];
      if (!value) throw new Error("--target requires a value");
      targets.push(value);
      continue;
    }
    if (arg === "--lock-file") {
      const value = argv[++i];
      if (!value) throw new Error("--lock-file requires a value");
      lockFile = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const selectedTargets = targets.length ? targets : SUPPORTED_TARGETS;
  for (const target of selectedTargets) {
    if (!SUPPORTED_TARGETS.includes(target)) {
      throw new Error(`Unsupported target '${target}'`);
    }
  }
  return { targets: selectedTargets, lockFile };
}

async function githubJson(endpoint) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "berd-acp-tools-lock",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com/${endpoint}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${endpoint} failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

async function npmView(spec, fields) {
  const cacheKey = `${spec}\0${fields.join("\0")}`;
  if (!npmViewCache.has(cacheKey)) {
    npmViewCache.set(
      cacheKey,
      execFileAsync("npm", ["view", spec, ...fields, "--json"], {
        maxBuffer: 10 * 1024 * 1024,
      }).then(({ stdout }) => {
        try {
          return JSON.parse(stdout);
        } catch (error) {
          throw new Error(
            `npm view ${spec} returned invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }
  return npmViewCache.get(cacheKey);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function packageDist(metadata, label) {
  const dist = metadata?.dist;
  return {
    tarball: requireString(dist?.tarball, `${label} dist.tarball`),
    integrity: requireString(dist?.integrity, `${label} dist.integrity`),
  };
}

function parseNpmAliasSpec(spec, fallbackPackage) {
  if (!spec.startsWith("npm:")) {
    return { packageName: fallbackPackage, version: spec };
  }
  const aliased = spec.slice("npm:".length);
  const versionSeparator = aliased.lastIndexOf("@");
  if (versionSeparator <= 0) {
    throw new Error(`Unsupported npm alias spec: ${spec}`);
  }
  return {
    packageName: aliased.slice(0, versionSeparator),
    version: aliased.slice(versionSeparator + 1),
  };
}

function releaseTimestamp(release) {
  return Date.parse(release.published_at ?? release.created_at ?? "") || 0;
}

async function stableReleasesForTool(tool) {
  if (!releaseCache.has(tool.repo)) {
    releaseCache.set(
      tool.repo,
      githubJson(`repos/${tool.repo}/releases?per_page=100`).then((releases) =>
        releases
          .filter((release) => !release.prerelease && !release.draft)
          .sort(
            (left, right) => releaseTimestamp(right) - releaseTimestamp(left),
          ),
      ),
    );
  }
  return releaseCache.get(tool.repo);
}

function assetMatchesTarget(assetName, target) {
  const name = assetName.toLowerCase();
  const patterns = TARGET_PATTERNS[target];
  if (patterns.exclude.some((token) => name.includes(token))) return false;
  return (
    patterns.os.some((token) => name.includes(token)) &&
    patterns.arch.some((token) => name.includes(token))
  );
}

function selectAsset(assets, tool, target) {
  const candidates = assets.filter((asset) =>
    assetMatchesTarget(asset.name, target),
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const exactBinary = candidates.find((asset) =>
      asset.name.toLowerCase().includes(tool.binary.toLowerCase()),
    );
    if (exactBinary) return exactBinary;
    throw new Error(
      `Multiple ${tool.id} assets match ${target}: ${candidates
        .map((asset) => asset.name)
        .join(", ")}`,
    );
  }
  throw new Error(
    `${tool.repo} release does not contain a binary asset for ${target}. ` +
      `Assets found: ${
        assets.map((asset) => asset.name).join(", ") || "(none)"
      }`,
  );
}

function assetNames(assets) {
  return assets.map((asset) => asset.name).join(", ") || "(none)";
}

async function downloadToTemp(url, tempDir) {
  const response = await fetch(url, {
    headers: { "User-Agent": "berd-acp-tools-lock" },
  });
  if (!response.ok) {
    throw new Error(
      `Download failed: ${url} (${response.status} ${response.statusText})`,
    );
  }
  const file = path.join(tempDir, path.basename(new URL(url).pathname));
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(file, bytes);
  return file;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function lockGithubToolForTarget(tool, target, tempDir) {
  const stableReleases = await stableReleasesForTool(tool);
  const latestRelease = stableReleases[0];

  if (!latestRelease) {
    throw new Error(`${tool.repo} does not have any stable GitHub releases.`);
  }

  const latestAssets = latestRelease.assets ?? [];
  if (!latestAssets.some((asset) => assetMatchesTarget(asset.name, target))) {
    const olderMatch = stableReleases.find((release) =>
      (release.assets ?? []).some((asset) =>
        assetMatchesTarget(asset.name, target),
      ),
    );
    const olderMatchHint = olderMatch
      ? ` The newest older matching release is ${olderMatch.tag_name}; refusing to use it because that would leave the bundled tool stale.`
      : "";

    throw new Error(
      `${tool.repo} latest stable release ${latestRelease.tag_name} does not contain a binary asset for ${target}.` +
        `${olderMatchHint} Assets found on ${latestRelease.tag_name}: ${assetNames(latestAssets)}`,
    );
  }

  const asset = selectAsset(latestAssets, tool, target);
  const downloaded = await downloadToTemp(asset.browser_download_url, tempDir);
  return {
    id: tool.id,
    binary: tool.binary,
    source: "github_release",
    repo: tool.repo,
    tag: latestRelease.tag_name,
    sha256: await sha256File(downloaded),
    asset: asset.name,
    target,
  };
}

async function lockNpmToolForTarget(tool, target) {
  const npmTarget = NPM_TARGET_CONFIG[target];
  if (!npmTarget) {
    throw new Error(`No npm target mapping for ${target}`);
  }

  const packageName = tool.package;
  const packageMetadata = await npmView(`${packageName}@latest`, [
    "name",
    "version",
    "dist",
    "dependencies",
    "engines",
    "bin",
  ]);

  if (packageMetadata.name !== packageName) {
    throw new Error(
      `npm package ${packageName} resolved to ${packageMetadata.name}`,
    );
  }

  const version = requireString(
    packageMetadata.version,
    `${packageName} version`,
  );
  const packageInfo = packageDist(packageMetadata, `${packageName}@${version}`);
  const entry = {
    id: tool.id,
    binary: tool.binary,
    source: "npm",
    package: packageName,
    version,
    integrity: packageInfo.integrity,
    tarball: packageInfo.tarball,
    target,
    npmOs: npmTarget.npmOs,
    npmCpu: npmTarget.npmCpu,
    ...(npmTarget.npmLibc ? { npmLibc: npmTarget.npmLibc } : {}),
    nodeEngine: packageMetadata.engines?.node ?? ">=22",
  };

  if (!tool.dependencyPackage) {
    return entry;
  }

  const dependencyRange = requireString(
    packageMetadata.dependencies?.[tool.dependencyPackage],
    `${packageName} dependency ${tool.dependencyPackage}`,
  );
  const dependencyMetadata = await npmView(
    `${tool.dependencyPackage}@${dependencyRange}`,
    ["name", "version", "dist", "optionalDependencies", "claudeCodeVersion"],
  );
  const dependencyVersion = requireString(
    dependencyMetadata.version,
    `${tool.dependencyPackage}@${dependencyRange} version`,
  );
  const dependencyInfo = packageDist(
    dependencyMetadata,
    `${tool.dependencyPackage}@${dependencyVersion}`,
  );
  entry.dependencyPackage = tool.dependencyPackage;
  entry.dependencyVersion = dependencyVersion;
  entry.dependencyIntegrity = dependencyInfo.integrity;
  entry.dependencyTarball = dependencyInfo.tarball;
  if (tool.includeClaudeCodeVersion) {
    entry.claudeCodeVersion = dependencyMetadata.claudeCodeVersion ?? null;
  }

  const nativePackage = requireString(
    npmTarget.nativePackages?.[tool.nativePackageKey],
    `${target} native package for ${tool.nativePackageKey}`,
  );
  const nativeExecutable = requireString(
    npmTarget.nativeExecutables?.[tool.nativePackageKey],
    `${target} native executable for ${tool.nativePackageKey}`,
  );
  const nativeSpec = requireString(
    dependencyMetadata.optionalDependencies?.[nativePackage],
    `${tool.dependencyPackage}@${dependencyVersion} optional dependency ${nativePackage}`,
  );
  const nativeAlias = parseNpmAliasSpec(nativeSpec, nativePackage);
  const nativeMetadata = await npmView(
    `${nativeAlias.packageName}@${nativeAlias.version}`,
    ["name", "version", "dist"],
  );
  const nativeVersion = requireString(
    nativeMetadata.version,
    `${nativeAlias.packageName}@${nativeAlias.version} version`,
  );
  if (nativeVersion !== nativeAlias.version) {
    throw new Error(
      `${nativeAlias.packageName}@${nativeAlias.version} resolved to ${nativeVersion}`,
    );
  }
  const nativeInfo = packageDist(
    nativeMetadata,
    `${nativeAlias.packageName}@${nativeVersion}`,
  );

  return {
    ...entry,
    nativePackage,
    nativePackageName: nativeMetadata.name ?? nativePackage,
    nativeVersion,
    nativeIntegrity: nativeInfo.integrity,
    nativeTarball: nativeInfo.tarball,
    nativeExecutable,
  };
}

async function lockToolForTarget(tool, target, tempDir) {
  if (tool.source === "npm") {
    return lockNpmToolForTarget(tool, target);
  }
  return lockGithubToolForTarget(tool, target, tempDir);
}

async function main() {
  const { targets, lockFile } = parseArgs(process.argv.slice(2));
  const tempDir = await mkdtemp(path.join(tmpdir(), "berd-acp-tools-"));
  try {
    const tools = [];
    for (const tool of TOOL_SPECS) {
      for (const target of targets) {
        tools.push(await lockToolForTarget(tool, target, tempDir));
      }
    }
    tools.sort((left, right) =>
      `${left.id}:${left.target}`.localeCompare(`${right.id}:${right.target}`),
    );
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ tools }, null, 2)}\n`);
    console.log(`Updated ${path.relative(process.cwd(), lockFile)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
