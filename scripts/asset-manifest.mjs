import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";

export const MANIFEST_FILENAME = "manifest.json";
export const LATEST_FILENAME = "latest.json";
export const CATALOG_VERSION_PATTERN = /^\d{8}T\d{9}Z$/;

export function generateCatalogVersion(now = new Date()) {
  return now.toISOString().replace(/[-:.]/g, "");
}

export function validateCatalogVersion(value, label = "Asset") {
  if (!CATALOG_VERSION_PATTERN.test(value)) {
    throw new Error(
      `${label} catalog version must match YYYYMMDDTHHMMSSmmmZ: ${value}`,
    );
  }
}

export async function assetMetadata(file, mimeType) {
  const bytes = await readFile(file);
  return {
    mimeType,
    byteSize: (await stat(file)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function artifactUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}/${path}`;
}

export function serializedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function authHeaders() {
  const token = process.env.ARTIFACTORY_IDENTITY_TOKEN;
  if (!token) {
    throw new Error("ARTIFACTORY_IDENTITY_TOKEN is required.");
  }
  return { Authorization: `Bearer ${token}` };
}

export async function fetchArtifact(fetchImpl, baseUrl, path, init) {
  return fetchImpl(artifactUrl(baseUrl, path), {
    ...init,
    headers: {
      ...authHeaders(),
      ...init?.headers,
    },
  });
}

export async function ensureRemoteMissing(
  fetchImpl,
  baseUrl,
  path,
  label = "asset",
) {
  const response = await fetchArtifact(fetchImpl, baseUrl, path, {
    method: "HEAD",
  });
  if (response.ok) {
    throw new Error(
      `Refusing to overwrite existing ${label} artifact: ${path}`,
    );
  }
  if (response.status !== 404) {
    throw new Error(
      `Failed to preflight ${path}: ${response.status} ${response.statusText}`,
    );
  }
}

export async function putArtifact(
  fetchImpl,
  baseUrl,
  path,
  body,
  contentType,
  { createOnly = false, ifMatch } = {},
) {
  const response = await fetchArtifact(fetchImpl, baseUrl, path, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      ...(createOnly ? { "If-None-Match": "*" } : {}),
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to publish ${path}: ${response.status} ${response.statusText}`,
    );
  }
}

export async function latestWritePrecondition(fetchImpl, baseUrl) {
  const response = await fetchArtifact(fetchImpl, baseUrl, LATEST_FILENAME, {
    method: "HEAD",
  });
  if (response.status === 404) {
    return { createOnly: true };
  }
  if (!response.ok) {
    throw new Error(
      `Failed to preflight ${LATEST_FILENAME}: ${response.status} ${response.statusText}`,
    );
  }

  const etag = response.headers.get("etag");
  if (!etag) {
    throw new Error(
      `${LATEST_FILENAME} did not return an ETag for safe promotion.`,
    );
  }
  return { ifMatch: etag };
}

function headerValue(headers, names) {
  for (const name of names) {
    const value = headers.get(name);
    if (value) {
      return value;
    }
  }
  return null;
}

async function remoteAssetSha256(fetchImpl, baseUrl, version, path, head) {
  const checksum = headerValue(head.headers, [
    "x-checksum-sha256",
    "x-artifactory-sha256",
    "sha256",
  ]);
  if (checksum) {
    return checksum.toLowerCase();
  }

  const response = await fetchArtifact(
    fetchImpl,
    baseUrl,
    `${version}/${path}`,
    {
      method: "GET",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch asset ${version}/${path} for checksum: ${response.status} ${response.statusText}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyRemoteAsset(
  fetchImpl,
  baseUrl,
  version,
  path,
  byteSize,
  sha256,
  label = "asset",
) {
  const response = await fetchArtifact(
    fetchImpl,
    baseUrl,
    `${version}/${path}`,
    {
      method: "HEAD",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Missing ${label} asset ${version}/${path}: ${response.status} ${response.statusText}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (
    typeof byteSize === "number" &&
    contentLength !== null &&
    Number(contentLength) !== byteSize
  ) {
    throw new Error(
      `${label} asset ${version}/${path} byte size mismatch: expected ${byteSize}, got ${contentLength}.`,
    );
  }
  const actualSha256 = await remoteAssetSha256(
    fetchImpl,
    baseUrl,
    version,
    path,
    response,
  );
  if (actualSha256 !== sha256.toLowerCase()) {
    throw new Error(
      `${label} asset ${version}/${path} checksum mismatch: expected ${sha256}, got ${actualSha256}.`,
    );
  }
}

export async function fetchRemoteManifest({
  fetchImpl,
  baseUrl,
  version,
  validateManifest,
  label = "asset",
}) {
  const path = `${version}/${MANIFEST_FILENAME}`;
  const response = await fetchArtifact(fetchImpl, baseUrl, path, {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${label} manifest ${path}: ${response.status} ${response.statusText}`,
    );
  }
  const manifest = JSON.parse(await response.text());
  validateManifest(manifest);
  if (manifest.catalogVersion !== version) {
    throw new Error(
      `Remote manifest catalogVersion ${manifest.catalogVersion} does not match requested version ${version}.`,
    );
  }
  return manifest;
}
