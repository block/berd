#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  fetchRemoteManifest,
  generateCatalogVersion,
  latestWritePrecondition,
  MANIFEST_FILENAME,
  putArtifact,
  serializedJson,
  validateCatalogVersion,
  verifyRemoteAsset,
  ensureRemoteMissing as ensureSharedRemoteMissing,
} from "./asset-manifest.mjs";

export { generateCatalogVersion };

export const ARTIFACTORY_BASE =
  "https://global.block-artifacts.com/artifactory/goose-internal/avatars";

const FORMATS = ["webm", "hevc"];
const EXPECTED_EXTENSION_BY_FORMAT = {
  webm: ".webm",
  hevc: ".mp4",
};
const COLLECTION_LABELS = {
  fuzzies: "Fuzzies",
  gloopies: "Gloopies",
  pollies: "Pollies",
};
function optionValue(args, name) {
  const prefix = `${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value?.slice(prefix.length);
}

function parseArgs(argv) {
  const [maybeMode, ...rest] = argv;
  const mode = ["manifest", "publish", "promote"].includes(maybeMode)
    ? maybeMode
    : "manifest";
  const args = mode === "manifest" ? argv : rest;

  if (args.includes("--publish")) {
    throw new Error(
      "--publish is no longer supported. Use pnpm avatars:publish -- --source=/path/to/avatars.",
    );
  }

  return {
    mode,
    source: optionValue(args, "--source"),
    version: optionValue(args, "--version"),
    out: optionValue(args, "--out") ?? "avatar-manifest.json",
  };
}

function labelFromId(id) {
  return id
    .split(/[-_]+/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function mimeTypeFor(format) {
  return format === "webm" ? "video/webm" : "video/mp4";
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function requireSourceDir(source) {
  if (!source) {
    throw new Error(
      "--source=/path/to/avatars is required. The app no longer keeps avatar media in the repo.",
    );
  }
  await access(join(source, "webm"));
  await access(join(source, "hevc"));
}

function normalizedRelativePath(from, to) {
  return relative(from, to).replaceAll("\\", "/");
}

function parseSourceAssetPath(source, file) {
  const rel = normalizedRelativePath(source, file);
  const parts = rel.split("/");
  const [format, collectionId, filename] = parts;

  if (!FORMATS.includes(format)) {
    throw new Error(
      `Unsupported avatar source file outside webm/ or hevc/: ${rel}`,
    );
  }
  if (parts.length !== 3 || !collectionId || !filename) {
    throw new Error(
      `Avatar source file must match {format}/{collection}/{filename}: ${rel}`,
    );
  }

  const expectedExtension = EXPECTED_EXTENSION_BY_FORMAT[format];
  const extension = extname(filename).toLowerCase();
  if (extension !== expectedExtension) {
    throw new Error(
      `Unsupported avatar source file extension for ${format}: ${rel}`,
    );
  }

  return {
    id: basename(filename, extension),
    collectionId,
    format,
    rel,
  };
}

async function variantForFile(source, file) {
  const { id, collectionId, format, rel } = parseSourceAssetPath(source, file);
  const bytes = await readFile(file);
  return {
    id,
    collectionId,
    format,
    variant: {
      path: rel,
      mimeType: mimeTypeFor(format),
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function validateVariantPath(asset, format, variant) {
  const parts = variant.path.split("/");
  if (
    parts.length !== 3 ||
    parts[0] !== format ||
    parts[1] !== asset.collectionId ||
    !parts[2]
  ) {
    throw new Error(
      `Avatar ${asset.id} has invalid ${format} path: ${variant.path}`,
    );
  }
}

export async function buildManifest({ source, version }) {
  await requireSourceDir(source);

  const variants = [];

  for (const file of await listFiles(source)) {
    variants.push(await variantForFile(source, file));
  }

  const seenByFormat = new Set();
  for (const item of variants) {
    const formatKey = `${item.format}:${item.id}`;
    if (seenByFormat.has(formatKey)) {
      throw new Error(`Duplicate avatar id in ${item.format}: ${item.id}`);
    }
    seenByFormat.add(formatKey);
  }

  const collectionById = new Map();
  for (const item of variants) {
    const existingCollection = collectionById.get(item.id);
    if (existingCollection && existingCollection !== item.collectionId) {
      throw new Error(
        `Avatar id ${item.id} appears in multiple collections: ${existingCollection}, ${item.collectionId}`,
      );
    }
    collectionById.set(item.id, item.collectionId);
  }

  const assetsById = new Map();
  for (const item of variants) {
    const existing = assetsById.get(item.id) ?? {
      id: item.id,
      label: labelFromId(item.id),
      collectionId: item.collectionId,
      variants: {},
    };
    existing.variants[item.format] = item.variant;
    assetsById.set(item.id, existing);
  }

  const assets = [...assetsById.values()].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true }),
  );
  const collectionsById = new Map();
  for (const asset of assets) {
    const collection = collectionsById.get(asset.collectionId) ?? {
      id: asset.collectionId,
      label:
        COLLECTION_LABELS[asset.collectionId] ??
        labelFromId(asset.collectionId),
      coverAvatarId: asset.id,
      avatarIds: [],
    };
    collection.avatarIds.push(asset.id);
    collectionsById.set(asset.collectionId, collection);
  }

  const manifest = {
    schemaVersion: 1,
    catalogVersion: version,
    collections: [...collectionsById.values()].sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
    assets,
  };
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (manifest.collections.length === 0 || manifest.assets.length === 0) {
    throw new Error(
      "Avatar manifest must contain at least one collection and asset.",
    );
  }

  const collectionIds = new Set();
  for (const collection of manifest.collections) {
    if (collectionIds.has(collection.id)) {
      throw new Error(`Duplicate avatar collection id: ${collection.id}`);
    }
    collectionIds.add(collection.id);
    if (collection.avatarIds.length === 0) {
      throw new Error(`Avatar collection is empty: ${collection.id}`);
    }
  }

  const assetIds = new Set();
  const assetsById = new Map();
  for (const asset of manifest.assets) {
    if (assetIds.has(asset.id)) {
      throw new Error(`Duplicate avatar id: ${asset.id}`);
    }
    assetIds.add(asset.id);
    assetsById.set(asset.id, asset);

    if (!asset.variants.webm || !asset.variants.hevc) {
      throw new Error(
        `Avatar ${asset.id} must include both WebM and HEVC variants.`,
      );
    }
    validateVariantPath(asset, "webm", asset.variants.webm);
    validateVariantPath(asset, "hevc", asset.variants.hevc);
  }

  for (const collection of manifest.collections) {
    const cover = assetsById.get(collection.coverAvatarId);
    if (!cover || cover.collectionId !== collection.id) {
      throw new Error(
        `Avatar collection has an invalid cover: ${collection.id}`,
      );
    }
    for (const avatarId of collection.avatarIds) {
      const asset = assetsById.get(avatarId);
      if (!asset || asset.collectionId !== collection.id) {
        throw new Error(
          `Avatar collection ${collection.id} references invalid asset ${avatarId}.`,
        );
      }
    }
  }
}

async function ensureRemoteMissing(fetchImpl, baseUrl, path) {
  await ensureSharedRemoteMissing(fetchImpl, baseUrl, path, "avatar");
}

function manifestAssetPaths(manifest) {
  const paths = [];
  for (const asset of manifest.assets) {
    paths.push(asset.variants.webm.path, asset.variants.hevc.path);
  }
  return paths;
}

export async function publishAvatars({
  source,
  fetchImpl = fetch,
  baseUrl = ARTIFACTORY_BASE,
  now = new Date(),
  onProgress = () => {},
} = {}) {
  const version = generateCatalogVersion(now);
  validateCatalogVersion(version, "Avatar");
  onProgress({ type: "manifest:start", version });
  const manifest = await buildManifest({ source, version });
  const assetPaths = manifestAssetPaths(manifest);
  const targetPaths = [
    ...assetPaths.map((path) => `${version}/${path}`),
    `${version}/${MANIFEST_FILENAME}`,
  ];
  onProgress({
    type: "manifest:done",
    assetCount: manifest.assets.length,
    objectCount: targetPaths.length,
    version,
  });

  for (const [index, path] of targetPaths.entries()) {
    onProgress({
      type: "preflight",
      current: index + 1,
      total: targetPaths.length,
      path,
    });
    await ensureRemoteMissing(fetchImpl, baseUrl, path);
  }

  for (const [index, path] of assetPaths.entries()) {
    onProgress({
      type: "upload",
      current: index + 1,
      total: targetPaths.length,
      path: `${version}/${path}`,
    });
    await putArtifact(
      fetchImpl,
      baseUrl,
      `${version}/${path}`,
      await readFile(join(source, path)),
      "application/octet-stream",
      { createOnly: true },
    );
  }
  onProgress({
    type: "upload",
    current: targetPaths.length,
    total: targetPaths.length,
    path: `${version}/${MANIFEST_FILENAME}`,
  });
  await putArtifact(
    fetchImpl,
    baseUrl,
    `${version}/${MANIFEST_FILENAME}`,
    serializedJson(manifest),
    "application/json",
    { createOnly: true },
  );

  return { version, manifest };
}

export async function promoteAvatars({
  version,
  fetchImpl = fetch,
  baseUrl = ARTIFACTORY_BASE,
} = {}) {
  if (!version) {
    throw new Error("--version is required for avatar promotion.");
  }
  validateCatalogVersion(version, "Avatar");

  const manifest = await fetchRemoteManifest({
    fetchImpl,
    baseUrl,
    version,
    validateManifest,
    label: "avatar",
  });
  for (const asset of manifest.assets) {
    await verifyRemoteAsset(
      fetchImpl,
      baseUrl,
      version,
      asset.variants.webm.path,
      asset.variants.webm.byteSize,
      asset.variants.webm.sha256,
      "avatar",
    );
    await verifyRemoteAsset(
      fetchImpl,
      baseUrl,
      version,
      asset.variants.hevc.path,
      asset.variants.hevc.byteSize,
      asset.variants.hevc.sha256,
      "avatar",
    );
  }

  const latest = {
    catalogVersion: version,
    manifestPath: `${version}/${MANIFEST_FILENAME}`,
  };
  const precondition = await latestWritePrecondition(fetchImpl, baseUrl);
  await putArtifact(
    fetchImpl,
    baseUrl,
    "latest.json",
    serializedJson(latest),
    "application/json",
    precondition,
  );
  return latest;
}

function logPublishProgress(event) {
  if (event.type === "manifest:start") {
    console.log(`Building avatar manifest for ${event.version}...`);
    return;
  }
  if (event.type === "manifest:done") {
    console.log(
      `Manifest includes ${event.assetCount} avatars; publishing ${event.objectCount} objects.`,
    );
    return;
  }
  if (event.type === "preflight") {
    console.log(`Preflight ${event.current}/${event.total}: ${event.path}`);
    return;
  }
  if (event.type === "upload") {
    console.log(`Upload ${event.current}/${event.total}: ${event.path}`);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const { mode, source, version, out } = parseArgs(argv);

  if (mode === "manifest") {
    if (!version) {
      throw new Error(
        "--version is required when generating an avatar manifest.",
      );
    }
    const manifest = await buildManifest({ source, version });
    await writeFile(out, serializedJson(manifest));
    console.log(`Wrote ${manifest.assets.length} avatars to ${out}`);
    return;
  }

  if (mode === "publish") {
    const result = await publishAvatars({
      source,
      onProgress: logPublishProgress,
    });
    console.log(`Published avatars/${result.version}`);
    console.log(
      `Promote with: pnpm avatars:promote -- --version=${result.version}`,
    );
    return;
  }

  await promoteAvatars({ version });
  console.log(`Promoted avatars/${version} to latest.json`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
