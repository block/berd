#!/usr/bin/env node
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  assetMetadata,
  fetchArtifact,
  fetchRemoteManifest,
  generateCatalogVersion,
  latestWritePrecondition,
  MANIFEST_FILENAME,
  putArtifact,
  responseErrorDetails,
  serializedJson,
  validateCatalogVersion,
  verifyRemoteAsset,
  verifyRemoteObject,
} from "./asset-manifest.mjs";

export const ARTIFACTORY_BASE =
  "https://global.block-artifacts.com/artifactory/goose-internal/artifacts";

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
    out: optionValue(args, "--out") ?? "artifacts-manifest.json",
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
      "--source=/path/to/assets is required. The app no longer keeps startup artifact media in the repo.",
    );
  }
  if (basename(source) !== "assets") {
    throw new Error("Artifact source must be the assets directory.");
  }
  await access(source);
}

function manifestRootForSource(source) {
  return dirname(source);
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
    throw new Error(`Unsafe artifact path: ${path}`);
  }
}

function isDotfilePath(path) {
  return path.split("/").some((part) => part.startsWith("."));
}

function parseArtifactPath(source, file) {
  const rel = normalizedRelativePath(source, file);
  validateSafeRelativePath(rel);
  const parts = rel.split("/");
  const [root, folder, maybeCollectionId, filename] = parts;

  if (root !== "assets") {
    throw new Error(`Unsupported artifact source file outside assets/: ${rel}`);
  }

  if (folder === "hdri" && parts.length === 3 && maybeCollectionId) {
    const extension = extname(maybeCollectionId).toLowerCase();
    if (extension !== ".exr") {
      throw new Error(`Unsupported environment extension: ${rel}`);
    }
    return {
      kind: "environment",
      rel,
      mimeType: "image/x-exr",
    };
  }

  if (folder === "project-images" && parts.length === 3 && maybeCollectionId) {
    const extension = extname(maybeCollectionId).toLowerCase();
    if (extension !== ".webp") {
      throw new Error(`Unsupported project image extension: ${rel}`);
    }
    return {
      kind: "projectImage",
      rel,
      mimeType: "image/webp",
    };
  }

  if (
    folder === "images" &&
    parts.length === 4 &&
    maybeCollectionId &&
    filename
  ) {
    const extension = extname(filename).toLowerCase();
    if (extension !== ".png") {
      throw new Error(`Unsupported collection image extension: ${rel}`);
    }
    return {
      kind: "collectionImage",
      collectionId: maybeCollectionId,
      rel,
      mimeType: "image/png",
    };
  }

  throw new Error(
    `Artifact source file must match assets/hdri/{filename}.exr, assets/project-images/{filename}.webp, or assets/images/{collection}/{filename}.png: ${rel}`,
  );
}

async function manifestEntryForFile(source, file) {
  const parsed = parseArtifactPath(source, file);
  return {
    ...parsed,
    ...(await assetMetadata(file, parsed.mimeType)),
  };
}

export async function buildArtifactManifest({ source, version }) {
  await requireSourceDir(source);
  const manifestRoot = manifestRootForSource(source);

  const entries = [];
  for (const file of await listFiles(source)) {
    const rel = normalizedRelativePath(manifestRoot, file);
    if (isDotfilePath(rel)) {
      continue;
    }
    entries.push(await manifestEntryForFile(manifestRoot, file));
  }

  const assets = entries.sort((left, right) =>
    left.rel.localeCompare(right.rel),
  );

  const manifest = {
    schemaVersion: 1,
    catalogVersion: version,
    assets: assets.map(
      ({ kind, rel, mimeType, byteSize, sha256, collectionId }) => ({
        kind,
        path: rel,
        mimeType,
        byteSize,
        sha256,
        ...(collectionId ? { collectionId } : {}),
      }),
    ),
  };
  validateArtifactManifest(manifest);
  return manifest;
}

export function validateArtifactManifest(manifest) {
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported artifact manifest schema.");
  }
  validateCatalogVersion(manifest.catalogVersion, "Artifact");
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error("Artifact manifest must contain at least one asset.");
  }
  let previousPath = "";
  for (const asset of manifest.assets) {
    validateArtifactEntry(asset);
    if (previousPath && previousPath >= asset.path) {
      throw new Error("Artifact manifest paths must be sorted.");
    }
    previousPath = asset.path;
  }
}

function validateArtifactEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Artifact entry is invalid.");
  }
  validateSafeRelativePath(entry.path);
  if (entry.kind === "environment") {
    validateArtifactPath(entry, "assets/hdri/", ".exr", "image/x-exr");
  } else if (entry.kind === "projectImage") {
    validateArtifactPath(
      entry,
      "assets/project-images/",
      ".webp",
      "image/webp",
    );
  } else if (entry.kind === "collectionImage") {
    validateArtifactPath(entry, "assets/images/", ".png", "image/png");
    if (
      typeof entry.collectionId !== "string" ||
      entry.collectionId.length === 0
    ) {
      throw new Error(
        `Collection image is missing collectionId: ${entry.path}`,
      );
    }
  } else {
    throw new Error(`Unsupported artifact kind: ${entry.kind}`);
  }
  if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0) {
    throw new Error(`Artifact byte size is invalid: ${entry.path}`);
  }
  if (
    typeof entry.sha256 !== "string" ||
    entry.sha256.length !== 64 ||
    !/^[0-9a-f]{64}$/i.test(entry.sha256)
  ) {
    throw new Error(`Artifact checksum is invalid: ${entry.path}`);
  }
}

function validateArtifactPath(entry, prefix, extension, mimeType) {
  if (!entry.path.startsWith(prefix) || extname(entry.path) !== extension) {
    throw new Error(`Artifact path is invalid: ${entry.path}`);
  }
  if (entry.mimeType !== mimeType) {
    throw new Error(`Artifact mime type is invalid: ${entry.path}`);
  }
}

function manifestAssetEntries(manifest) {
  return manifest.assets;
}

export async function publishArtifacts({
  source,
  fetchImpl = fetch,
  baseUrl = ARTIFACTORY_BASE,
  now = new Date(),
  version: requestedVersion,
  onProgress = () => {},
} = {}) {
  const version = requestedVersion ?? generateCatalogVersion(now);
  validateCatalogVersion(version, "Artifact");
  onProgress({ type: "manifest:start", version });
  const manifest = await buildArtifactManifest({ source, version });
  const manifestJson = serializedJson(manifest);
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

  const manifestPath = `${version}/${MANIFEST_FILENAME}`;
  const remoteManifest = await fetchArtifact(fetchImpl, baseUrl, manifestPath, {
    method: "GET",
  });
  if (remoteManifest.ok) {
    const remoteManifestJson = await remoteManifest.text();
    if (remoteManifestJson === manifestJson) {
      return { version, manifest };
    }
    throw new Error(
      `Remote artifact manifest already exists with different content: ${manifestPath}`,
    );
  }
  if (remoteManifest.status !== 404) {
    throw new Error(
      `Failed to preflight ${manifestPath}: ${await responseErrorDetails(remoteManifest)}`,
    );
  }

  for (const [index, entry] of assetEntries.entries()) {
    const path = `${version}/${entry.path}`;
    onProgress({
      type: "preflight",
      current: index + 1,
      total: targetPaths.length,
      path,
    });
    const response = await fetchArtifact(fetchImpl, baseUrl, path, {
      method: "HEAD",
    });
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to preflight ${path}: ${await responseErrorDetails(response)}`,
      );
    }
    await verifyRemoteObject(
      fetchImpl,
      baseUrl,
      path,
      entry.byteSize,
      entry.sha256,
      "artifact",
    );
  }

  for (const [index, entry] of assetEntries.entries()) {
    const path = `${version}/${entry.path}`;
    const response = await fetchArtifact(fetchImpl, baseUrl, path, {
      method: "HEAD",
    });
    if (response.ok) {
      continue;
    }
    if (response.status !== 404) {
      throw new Error(
        `Failed to preflight ${path}: ${await responseErrorDetails(response)}`,
      );
    }
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
      await readFile(join(manifestRootForSource(source), entry.path)),
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
    manifestPath,
    manifestJson,
    "application/json",
    { createOnly: true },
  );

  return { version, manifest };
}

export async function promoteArtifacts({
  version,
  fetchImpl = fetch,
  baseUrl = ARTIFACTORY_BASE,
} = {}) {
  if (!version) {
    throw new Error("--version is required for artifact promotion.");
  }
  validateCatalogVersion(version, "Artifact");

  const manifest = await fetchRemoteManifest({
    fetchImpl,
    baseUrl,
    version,
    validateManifest: validateArtifactManifest,
    label: "artifact",
  });
  for (const entry of manifestAssetEntries(manifest)) {
    await verifyRemoteAsset(
      fetchImpl,
      baseUrl,
      version,
      entry.path,
      entry.byteSize,
      entry.sha256,
      "artifact",
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
    console.log(`Building artifact manifest for ${event.version}...`);
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
    validateCatalogVersion(version, "Artifact");
    const manifest = await buildArtifactManifest({ source, version });
    await writeFile(out, serializedJson(manifest));
    console.log(`Wrote artifact manifest to ${out}`);
    return;
  }

  if (mode === "publish") {
    const { version: publishedVersion } = await publishArtifacts({
      source,
      version,
      onProgress: logPublishProgress,
    });
    console.log(
      `Published artifact catalog ${publishedVersion}. Promote it with: pnpm artifacts:promote -- --version=${publishedVersion}`,
    );
    return;
  }

  if (mode === "promote") {
    const latest = await promoteArtifacts({ version });
    console.log(
      `Promoted artifact catalog ${latest.catalogVersion} to latest.json`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
