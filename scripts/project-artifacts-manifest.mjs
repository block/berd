#!/usr/bin/env node
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  assetMetadata,
  fetchRemoteManifest,
  generateCatalogVersion,
  latestWritePrecondition,
  MANIFEST_FILENAME,
  putArtifact,
  serializedJson,
  validateCatalogVersion,
  verifyRemoteAsset,
  ensureRemoteMissing,
} from "./asset-manifest.mjs";

export const ARTIFACTORY_BASE =
  "https://global.block-artifacts.com/artifactory/goose-internal/project-artifacts";

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

  return {
    mode,
    source: optionValue(args, "--source"),
    version: optionValue(args, "--version"),
    out: optionValue(args, "--out") ?? "project-artifacts-manifest.json",
  };
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
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
      "--source=/path/to/project-artifacts is required. The app no longer keeps project artifact image media in the repo.",
    );
  }
  await access(join(source, "images"));
  await access(join(source, "hdri"));
}

function normalizedRelativePath(from, to) {
  return relative(from, to).replaceAll("\\", "/");
}

function validateSafeRelativePath(path) {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe project asset path: ${path}`);
  }
}

function parseProjectAssetPath(source, file) {
  const rel = normalizedRelativePath(source, file);
  validateSafeRelativePath(rel);
  const parts = rel.split("/");
  const [folder, filename] = parts;

  if (!["images", "hdri"].includes(folder)) {
    throw new Error(
      `Unsupported project asset source file outside images/ or hdri/: ${rel}`,
    );
  }
  if (parts.length !== 2 || !filename) {
    throw new Error(
      `Project asset source file must match images/{filename} or hdri/{filename}: ${rel}`,
    );
  }

  const extension = extname(filename).toLowerCase();
  if (folder === "images") {
    if (extension !== ".webp") {
      throw new Error(`Unsupported project image extension: ${rel}`);
    }
    return {
      kind: "image",
      id: basename(filename, extension),
      rel,
      mimeType: "image/webp",
    };
  }

  if (extension !== ".exr") {
    throw new Error(`Unsupported project environment extension: ${rel}`);
  }
  return {
    kind: "environment",
    id: basename(filename, extension),
    rel,
    mimeType: "image/x-exr",
  };
}

async function manifestEntryForFile(source, file) {
  const parsed = parseProjectAssetPath(source, file);
  return {
    ...parsed,
    ...(await assetMetadata(file, parsed.mimeType)),
  };
}

export async function buildProjectAssetManifest({ source, version }) {
  await requireSourceDir(source);

  const entries = [];
  for (const file of await listFiles(source)) {
    entries.push(await manifestEntryForFile(source, file));
  }

  const images = entries
    .filter((entry) => entry.kind === "image")
    .sort((left, right) => left.rel.localeCompare(right.rel));
  const environments = entries.filter((entry) => entry.kind === "environment");

  const ids = new Set();
  for (const image of images) {
    if (ids.has(image.id)) {
      throw new Error(`Duplicate project image id: ${image.id}`);
    }
    ids.add(image.id);
  }

  if (images.length === 0) {
    throw new Error("Project image manifest must contain at least one image.");
  }
  if (environments.length !== 1) {
    throw new Error(
      "Project image manifest must contain exactly one environment.",
    );
  }

  const manifest = {
    schemaVersion: 1,
    catalogVersion: version,
    images: images.map(({ id, rel, mimeType, byteSize, sha256 }) => ({
      id,
      path: rel,
      mimeType,
      byteSize,
      sha256,
    })),
    environment: {
      id: environments[0].id,
      path: environments[0].rel,
      mimeType: environments[0].mimeType,
      byteSize: environments[0].byteSize,
      sha256: environments[0].sha256,
    },
  };
  validateProjectAssetManifest(manifest);
  return manifest;
}

export function validateProjectAssetManifest(manifest) {
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported project image manifest schema.");
  }
  validateCatalogVersion(manifest.catalogVersion, "Project image");
  if (!Array.isArray(manifest.images) || manifest.images.length === 0) {
    throw new Error("Project image manifest must contain at least one image.");
  }
  const ids = new Set();
  let previousPath = "";
  for (const image of manifest.images) {
    validateProjectAssetEntry(image, "images", ".webp", "image/webp");
    if (previousPath && previousPath >= image.path) {
      throw new Error("Project image manifest paths must be sorted.");
    }
    previousPath = image.path;
    if (ids.has(image.id)) {
      throw new Error(`Duplicate project image id: ${image.id}`);
    }
    ids.add(image.id);
  }
  validateProjectAssetEntry(
    manifest.environment,
    "hdri",
    ".exr",
    "image/x-exr",
  );
}

function validateProjectAssetEntry(entry, folder, extension, mimeType) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Project asset entry is invalid.");
  }
  validateSafeRelativePath(entry.path);
  if (
    !entry.path.startsWith(`${folder}/`) ||
    extname(entry.path) !== extension
  ) {
    throw new Error(`Project asset path is invalid: ${entry.path}`);
  }
  if (entry.mimeType !== mimeType) {
    throw new Error(`Project asset mime type is invalid: ${entry.path}`);
  }
  if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0) {
    throw new Error(`Project asset byte size is invalid: ${entry.path}`);
  }
  if (
    typeof entry.sha256 !== "string" ||
    entry.sha256.length !== 64 ||
    !/^[0-9a-f]{64}$/i.test(entry.sha256)
  ) {
    throw new Error(`Project asset checksum is invalid: ${entry.path}`);
  }
}

function manifestAssetEntries(manifest) {
  return [...manifest.images, manifest.environment];
}

export async function publishProjectAssets({
  source,
  fetchImpl = fetch,
  baseUrl = ARTIFACTORY_BASE,
  now = new Date(),
  onProgress = () => {},
} = {}) {
  const version = generateCatalogVersion(now);
  validateCatalogVersion(version, "Project image");
  onProgress({ type: "manifest:start", version });
  const manifest = await buildProjectAssetManifest({ source, version });
  const assetEntries = manifestAssetEntries(manifest);
  const targetPaths = [
    ...assetEntries.map((entry) => `${version}/${entry.path}`),
    `${version}/${MANIFEST_FILENAME}`,
  ];
  onProgress({
    type: "manifest:done",
    assetCount: assetEntries.length,
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
    await ensureRemoteMissing(fetchImpl, baseUrl, path, "project image");
  }

  for (const [index, entry] of assetEntries.entries()) {
    const path = `${version}/${entry.path}`;
    onProgress({
      type: "upload",
      current: index + 1,
      total: targetPaths.length,
      path,
    });
    await putArtifact(
      fetchImpl,
      baseUrl,
      path,
      await readFile(join(source, entry.path)),
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

export async function promoteProjectAssets({
  version,
  fetchImpl = fetch,
  baseUrl = ARTIFACTORY_BASE,
} = {}) {
  if (!version) {
    throw new Error("--version is required for project image promotion.");
  }
  validateCatalogVersion(version, "Project image");

  const manifest = await fetchRemoteManifest({
    fetchImpl,
    baseUrl,
    version,
    validateManifest: validateProjectAssetManifest,
    label: "project image",
  });
  for (const entry of manifestAssetEntries(manifest)) {
    await verifyRemoteAsset(
      fetchImpl,
      baseUrl,
      version,
      entry.path,
      entry.byteSize,
      entry.sha256,
      "project image",
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
    console.log(`Building project image manifest for ${event.version}...`);
    return;
  }
  if (event.type === "manifest:done") {
    console.log(
      `Manifest includes ${event.assetCount} assets; publishing ${event.objectCount} objects.`,
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
      throw new Error("--version is required when generating a manifest file.");
    }
    validateCatalogVersion(version, "Project image");
    const manifest = await buildProjectAssetManifest({ source, version });
    await writeFile(out, serializedJson(manifest));
    console.log(`Wrote project image manifest to ${out}`);
    return;
  }

  if (mode === "publish") {
    const { version: publishedVersion } = await publishProjectAssets({
      source,
      onProgress: logPublishProgress,
    });
    console.log(
      `Published project image catalog ${publishedVersion}. Promote it with: pnpm project-artifacts:promote -- --version=${publishedVersion}`,
    );
    return;
  }

  if (mode === "promote") {
    const latest = await promoteProjectAssets({ version });
    console.log(
      `Promoted project image catalog ${latest.catalogVersion} to latest.json`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
