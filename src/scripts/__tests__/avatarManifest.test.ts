import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const avatarManifestScript = pathToFileURL(
  resolve(repoRoot, "scripts/avatar-manifest.mjs"),
).href;
const artifactManifestScript = pathToFileURL(
  resolve(repoRoot, "scripts/artifacts-manifest.mjs"),
).href;
const CATALOG_VERSION = "20260521T121530123Z";
const BASE_URL = "https://example.test/avatars";
const tempDirs: string[] = [];

type AvatarManifestModule = {
  buildManifest: (options: {
    source: string;
    version: string;
  }) => Promise<AvatarManifest>;
  generateCatalogVersion: (now?: Date) => string;
  promoteAvatars: (options: {
    version: string;
    fetchImpl: typeof fetch;
    baseUrl: string;
  }) => Promise<{ catalogVersion: string; manifestPath: string }>;
  publishAvatars: (options: {
    source: string;
    fetchImpl: typeof fetch;
    baseUrl: string;
    now?: Date;
    onProgress?: (event: { type: string }) => void;
  }) => Promise<{ version: string; manifest: AvatarManifest }>;
};

type ArtifactManifestModule = {
  buildArtifactManifest: (options: {
    source: string;
    version: string;
  }) => Promise<ArtifactManifest>;
  promoteArtifacts: (options: {
    version: string;
    fetchImpl: typeof fetch;
    baseUrl: string;
  }) => Promise<{ catalogVersion: string; manifestPath: string }>;
  publishArtifacts: (options: {
    source: string;
    fetchImpl: typeof fetch;
    baseUrl: string;
    now?: Date;
    version?: string;
    onProgress?: (event: { type: string }) => void;
  }) => Promise<{ version: string; manifest: ArtifactManifest }>;
};

type AvatarManifest = {
  catalogVersion: string;
  assets: Array<{
    id: string;
    variants: {
      webm: { path: string; byteSize: number; sha256: string };
      hevc: { path: string; byteSize: number; sha256: string };
    };
  }>;
};

type ArtifactManifest = {
  catalogVersion: string;
  assets: Array<{
    kind: "environment" | "projectImage" | "collectionImage";
    path: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    collectionId?: string;
  }>;
};

type StoredArtifact = {
  body: string;
  contentLength: number;
  contentType: string | null;
  sha256: string;
};

function storedJsonArtifact(body: string): StoredArtifact {
  return {
    body,
    contentLength: Buffer.byteLength(body),
    contentType: "application/json",
    sha256: sha256(body),
  };
}

function storedArtifact(body: string): StoredArtifact {
  return {
    body,
    contentLength: Buffer.byteLength(body),
    contentType: "application/octet-stream",
    sha256: sha256(body),
  };
}

function sha256(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

function makeTempDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "berd-avatar-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeAsset(source: string, path: string, body = path) {
  const fullPath = resolve(source, path);
  mkdirSync(resolve(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, body);
}

function writeCompleteSource(source = makeTempDir()) {
  writeAsset(source, "webm/gloopies/gloopy-1.webm", "webm-one");
  writeAsset(source, "hevc/gloopies/gloopy-1.mp4", "hevc-one");
  return source;
}

function writeCompleteArtifactSource(source = makeTempDir()) {
  for (let index = 1; index <= 12; index += 1) {
    const id = String(index).padStart(2, "0");
    writeAsset(
      source,
      `assets/project-images/memory-${id}.webp`,
      `memory-${id}`,
    );
  }
  writeAsset(source, "assets/images/fuzzies/fuzzy-01.png", "fuzzy-01");
  writeAsset(source, "assets/hdri/studio_soft.exr", "studio-soft");
  return resolve(source, "assets");
}

async function loadAvatarManifestModule() {
  return (await import(avatarManifestScript)) as AvatarManifestModule;
}

async function loadArtifactManifestModule() {
  return (await import(artifactManifestScript)) as ArtifactManifestModule;
}

function okResponse(body?: string, headers?: HeadersInit) {
  return new Response(body, { status: 200, statusText: "OK", headers });
}

function makeArtifactFetch(
  initialArtifacts: Record<string, StoredArtifact> = {},
) {
  const artifacts = new Map(Object.entries(initialArtifacts));
  const puts: Array<{
    path: string;
    body: string;
    contentType: string | null;
    ifNoneMatch: string | null;
    ifMatch: string | null;
  }> = [];
  const calls: Array<{ method: string; path: string }> = [];

  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const path = url.pathname.replace(/^\/avatars\//, "");
      const method = init?.method ?? "GET";
      calls.push({ method, path });

      if (method === "HEAD") {
        const artifact = artifacts.get(path);
        if (!artifact) {
          return new Response(null, { status: 404, statusText: "Not Found" });
        }
        return new Response(null, {
          status: 200,
          statusText: "OK",
          headers: {
            "content-length": String(artifact.contentLength),
            etag: `"${artifact.sha256}"`,
            "x-checksum-sha256": artifact.sha256,
          },
        });
      }

      if (method === "GET") {
        const artifact = artifacts.get(path);
        if (!artifact) {
          return new Response(null, { status: 404, statusText: "Not Found" });
        }
        return okResponse(artifact.body, {
          "content-length": String(artifact.contentLength),
          "content-type": artifact.contentType ?? "application/json",
        });
      }

      if (method === "PUT") {
        const headers = new Headers(init?.headers);
        const ifNoneMatch = headers.get("if-none-match");
        if (ifNoneMatch === "*" && artifacts.has(path)) {
          return new Response(null, {
            status: 412,
            statusText: "Precondition Failed",
          });
        }
        const ifMatch = headers.get("if-match");
        const existing = artifacts.get(path);
        if (ifMatch && (!existing || ifMatch !== `"${existing.sha256}"`)) {
          return new Response(null, {
            status: 412,
            statusText: "Precondition Failed",
          });
        }
        const body =
          typeof init?.body === "string"
            ? init.body
            : Buffer.from((init?.body as Uint8Array) ?? []).toString("utf8");
        const contentType = headers.get("content-type");
        artifacts.set(path, {
          body,
          contentLength: Buffer.byteLength(body),
          contentType,
          sha256: sha256(body),
        });
        puts.push({
          path,
          body,
          contentType,
          ifNoneMatch,
          ifMatch,
        });
        return okResponse();
      }

      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
      });
    },
  ) as unknown as typeof fetch;

  return { artifacts, calls, fetchImpl, puts };
}

describe("avatar manifest script", () => {
  beforeEach(() => {
    process.env.ARTIFACTORY_IDENTITY_TOKEN = "token";
  });

  afterEach(() => {
    delete process.env.ARTIFACTORY_IDENTITY_TOKEN;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("generates timestamp catalog versions in the safe publish format", async () => {
    const { generateCatalogVersion } = await loadAvatarManifestModule();

    expect(generateCatalogVersion(new Date("2026-05-21T12:15:30.123Z"))).toBe(
      CATALOG_VERSION,
    );
  });

  it("builds a manifest for complete webm and hevc variants", async () => {
    const { buildManifest } = await loadAvatarManifestModule();
    const source = writeCompleteSource();

    const manifest = await buildManifest({
      source,
      version: CATALOG_VERSION,
    });

    expect(manifest.catalogVersion).toBe(CATALOG_VERSION);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].variants.webm.path).toBe(
      "webm/gloopies/gloopy-1.webm",
    );
    expect(manifest.assets[0].variants.hevc.path).toBe(
      "hevc/gloopies/gloopy-1.mp4",
    );
  });

  it("allows collection ids and avatar ids to use different naming shapes", async () => {
    const { buildManifest } = await loadAvatarManifestModule();
    const source = makeTempDir();
    writeAsset(source, "webm/fuzzies/fuzzies-1.webm", "webm-one");
    writeAsset(source, "hevc/fuzzies/fuzzies-1.mp4", "hevc-one");

    const manifest = await buildManifest({
      source,
      version: CATALOG_VERSION,
    });

    expect(manifest.assets[0]).toMatchObject({
      id: "fuzzies-1",
      collectionId: "fuzzies",
    });
  });

  it("rejects duplicate ids across collections before merging variants", async () => {
    const { buildManifest } = await loadAvatarManifestModule();
    const source = makeTempDir();
    writeAsset(source, "webm/gloopies/gloopy-1.webm");
    writeAsset(source, "hevc/fuzzies/gloopy-1.mp4");

    await expect(
      buildManifest({ source, version: CATALOG_VERSION }),
    ).rejects.toThrow(/multiple collections/);
  });

  it("rejects duplicate ids within the same format", async () => {
    const { buildManifest } = await loadAvatarManifestModule();
    const source = makeTempDir();
    writeAsset(source, "webm/gloopies/gloopy-1.webm");
    writeAsset(source, "webm/fuzzies/gloopy-1.webm");
    writeAsset(source, "hevc/gloopies/gloopy-1.mp4");

    await expect(
      buildManifest({ source, version: CATALOG_VERSION }),
    ).rejects.toThrow(/Duplicate avatar id in webm/);
  });

  it("rejects missing webm or hevc variants", async () => {
    const { buildManifest } = await loadAvatarManifestModule();
    const source = makeTempDir();
    writeAsset(source, "webm/gloopies/gloopy-1.webm");
    mkdirSync(resolve(source, "hevc"), { recursive: true });

    await expect(
      buildManifest({ source, version: CATALOG_VERSION }),
    ).rejects.toThrow(/both WebM and HEVC/);
  });

  it("rejects unsupported and stray source files", async () => {
    const { buildManifest } = await loadAvatarManifestModule();
    const source = writeCompleteSource();
    writeAsset(source, "webm/gloopies/notes.txt");

    await expect(
      buildManifest({ source, version: CATALOG_VERSION }),
    ).rejects.toThrow(/Unsupported avatar source file extension/);

    rmSync(resolve(source, "webm/gloopies/notes.txt"));
    writeAsset(source, "README.md");

    await expect(
      buildManifest({ source, version: CATALOG_VERSION }),
    ).rejects.toThrow(/outside webm\/ or hevc\//);
  });

  it("fails publish when any remote target already exists", async () => {
    const { publishAvatars } = await loadAvatarManifestModule();
    const source = writeCompleteSource();
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact("{}"),
    });

    await expect(
      publishAvatars({
        source,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
        now: new Date("2026-05-21T12:15:30.123Z"),
      }),
    ).rejects.toThrow(/Refusing to overwrite/);
    expect(remote.puts).toEqual([]);
  });

  it("publishes manifest-referenced assets and manifest without latest.json", async () => {
    const { publishAvatars } = await loadAvatarManifestModule();
    const source = writeCompleteSource();
    writeAsset(source, "webm/gloopies/ignored.txt");
    rmSync(resolve(source, "webm/gloopies/ignored.txt"));
    const remote = makeArtifactFetch();
    const progress: Array<{ type: string }> = [];

    const result = await publishAvatars({
      source,
      fetchImpl: remote.fetchImpl,
      baseUrl: BASE_URL,
      now: new Date("2026-05-21T12:15:30.123Z"),
      onProgress: (event) => progress.push(event),
    });

    expect(result.version).toBe(CATALOG_VERSION);
    expect(progress.map((event) => event.type)).toEqual([
      "manifest:start",
      "manifest:done",
      "preflight",
      "preflight",
      "preflight",
      "upload",
      "upload",
      "upload",
    ]);
    expect(remote.puts.map((put) => put.path)).toEqual([
      `${CATALOG_VERSION}/webm/gloopies/gloopy-1.webm`,
      `${CATALOG_VERSION}/hevc/gloopies/gloopy-1.mp4`,
      `${CATALOG_VERSION}/manifest.json`,
    ]);
    expect(remote.puts.map((put) => put.path)).not.toContain("latest.json");
    expect(remote.puts.map((put) => put.ifNoneMatch)).toEqual(["*", "*", "*"]);
    expect(JSON.parse(remote.puts[2].body).catalogVersion).toBe(
      CATALOG_VERSION,
    );
  });

  it("rejects invalid promotion versions", async () => {
    const { promoteAvatars } = await loadAvatarManifestModule();
    const remote = makeArtifactFetch();

    await expect(
      promoteAvatars({
        version: "../v1",
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).rejects.toThrow(/catalog version must match/i);
    expect(remote.calls).toEqual([]);
  });

  it("promote fails when the remote manifest is missing", async () => {
    const { promoteAvatars } = await loadAvatarManifestModule();
    const remote = makeArtifactFetch();

    await expect(
      promoteAvatars({
        version: CATALOG_VERSION,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).rejects.toThrow(/Failed to fetch avatar manifest/);
  });

  it("promote fails when the remote manifest version does not match", async () => {
    const { buildManifest, promoteAvatars } = await loadAvatarManifestModule();
    const manifest = await buildManifest({
      source: writeCompleteSource(),
      version: CATALOG_VERSION,
    });
    const remote = makeArtifactFetch({
      "20260522T121530123Z/manifest.json": {
        body: JSON.stringify(manifest),
        contentLength: Buffer.byteLength(JSON.stringify(manifest)),
        contentType: "application/json",
        sha256: sha256(JSON.stringify(manifest)),
      },
    });

    await expect(
      promoteAvatars({
        version: "20260522T121530123Z",
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).rejects.toThrow(/does not match requested version/);
  });

  it("promote fails when a referenced asset is missing", async () => {
    const { buildManifest, promoteAvatars } = await loadAvatarManifestModule();
    const manifest = await buildManifest({
      source: writeCompleteSource(),
      version: CATALOG_VERSION,
    });
    const body = JSON.stringify(manifest);
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact(body),
    });

    await expect(
      promoteAvatars({
        version: CATALOG_VERSION,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).rejects.toThrow(/Missing avatar asset/);
  });

  it("promote fails when a referenced asset byte size does not match", async () => {
    const { buildManifest, promoteAvatars } = await loadAvatarManifestModule();
    const manifest = await buildManifest({
      source: writeCompleteSource(),
      version: CATALOG_VERSION,
    });
    const body = JSON.stringify(manifest);
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact(body),
      [`${CATALOG_VERSION}/webm/gloopies/gloopy-1.webm`]: {
        body: "wrong",
        contentLength: 999,
        contentType: "application/octet-stream",
        sha256: sha256("wrong"),
      },
      [`${CATALOG_VERSION}/hevc/gloopies/gloopy-1.mp4`]: {
        body: "hevc-one",
        contentLength: 8,
        contentType: "application/octet-stream",
        sha256: sha256("hevc-one"),
      },
    });

    await expect(
      promoteAvatars({
        version: CATALOG_VERSION,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).rejects.toThrow(/byte size mismatch/);
  });

  it("promote fails when a referenced asset checksum does not match", async () => {
    const { buildManifest, promoteAvatars } = await loadAvatarManifestModule();
    const manifest = await buildManifest({
      source: writeCompleteSource(),
      version: CATALOG_VERSION,
    });
    const body = JSON.stringify(manifest);
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact(body),
      [`${CATALOG_VERSION}/webm/gloopies/gloopy-1.webm`]: {
        ...storedArtifact("webm-one"),
        sha256: "0".repeat(64),
      },
      [`${CATALOG_VERSION}/hevc/gloopies/gloopy-1.mp4`]:
        storedArtifact("hevc-one"),
    });

    await expect(
      promoteAvatars({
        version: CATALOG_VERSION,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it("promote writes the expected minimal latest.json", async () => {
    const { buildManifest, promoteAvatars } = await loadAvatarManifestModule();
    const source = writeCompleteSource();
    const manifest = await buildManifest({
      source,
      version: CATALOG_VERSION,
    });
    const body = JSON.stringify(manifest);
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact(body),
      [`${CATALOG_VERSION}/webm/gloopies/gloopy-1.webm`]: {
        body: readFileSync(
          resolve(source, "webm/gloopies/gloopy-1.webm"),
          "utf8",
        ),
        contentLength: manifest.assets[0].variants.webm.byteSize,
        contentType: "application/octet-stream",
        sha256: manifest.assets[0].variants.webm.sha256,
      },
      [`${CATALOG_VERSION}/hevc/gloopies/gloopy-1.mp4`]: {
        body: readFileSync(
          resolve(source, "hevc/gloopies/gloopy-1.mp4"),
          "utf8",
        ),
        contentLength: manifest.assets[0].variants.hevc.byteSize,
        contentType: "application/octet-stream",
        sha256: manifest.assets[0].variants.hevc.sha256,
      },
      "latest.json": storedJsonArtifact(
        JSON.stringify({
          catalogVersion: "20260520T121530123Z",
          manifestPath: "20260520T121530123Z/manifest.json",
        }),
      ),
    });

    await expect(
      promoteAvatars({
        version: CATALOG_VERSION,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).resolves.toEqual({
      catalogVersion: CATALOG_VERSION,
      manifestPath: `${CATALOG_VERSION}/manifest.json`,
    });
    expect(remote.puts).toHaveLength(1);
    expect(remote.puts[0].path).toBe("latest.json");
    expect(remote.puts[0].ifNoneMatch).toBeNull();
    expect(remote.puts[0].ifMatch).toBeTruthy();
    expect(JSON.parse(remote.puts[0].body)).toEqual({
      catalogVersion: CATALOG_VERSION,
      manifestPath: `${CATALOG_VERSION}/manifest.json`,
    });
  });

  it("promote refuses to overwrite latest.json without a matching etag", async () => {
    const { buildManifest, promoteAvatars } = await loadAvatarManifestModule();
    const source = writeCompleteSource();
    const manifest = await buildManifest({
      source,
      version: CATALOG_VERSION,
    });
    const body = JSON.stringify(manifest);
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact(body),
      [`${CATALOG_VERSION}/webm/gloopies/gloopy-1.webm`]: {
        body: readFileSync(
          resolve(source, "webm/gloopies/gloopy-1.webm"),
          "utf8",
        ),
        contentLength: manifest.assets[0].variants.webm.byteSize,
        contentType: "application/octet-stream",
        sha256: manifest.assets[0].variants.webm.sha256,
      },
      [`${CATALOG_VERSION}/hevc/gloopies/gloopy-1.mp4`]: {
        body: readFileSync(
          resolve(source, "hevc/gloopies/gloopy-1.mp4"),
          "utf8",
        ),
        contentLength: manifest.assets[0].variants.hevc.byteSize,
        contentType: "application/octet-stream",
        sha256: manifest.assets[0].variants.hevc.sha256,
      },
      "latest.json": storedJsonArtifact(
        JSON.stringify({
          catalogVersion: "20260520T121530123Z",
          manifestPath: "20260520T121530123Z/manifest.json",
        }),
      ),
    });
    let staleLatest = false;
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (
          init?.method === "PUT" &&
          url.pathname.endsWith("/latest.json") &&
          !staleLatest
        ) {
          staleLatest = true;
          return new Response(null, {
            status: 412,
            statusText: "Precondition Failed",
          });
        }
        return remote.fetchImpl(input, init);
      },
    );

    await expect(
      promoteAvatars({
        version: CATALOG_VERSION,
        fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).rejects.toThrow(/Failed to publish latest\.json: 412/);
  });
});

describe("artifact manifest script", () => {
  beforeEach(() => {
    process.env.ARTIFACTORY_IDENTITY_TOKEN = "token";
  });

  afterEach(() => {
    delete process.env.ARTIFACTORY_IDENTITY_TOKEN;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("builds a manifest for supported assets", async () => {
    const { buildArtifactManifest } = await loadArtifactManifestModule();
    const root = makeTempDir();
    writeAsset(root, "assets/project-images/zebra.webp", "zebra");
    writeAsset(root, "assets/project-images/alpha.webp", "alpha");
    writeAsset(root, "assets/images/fuzzies/fuzzy-01.png", "fuzzy-01");
    writeAsset(root, "assets/hdri/loft.exr", "loft");
    writeAsset(root, "assets/.DS_Store", "dotfile");
    writeAsset(root, "video/ignored.mp4", "ignored");

    const manifest = await buildArtifactManifest({
      source: resolve(root, "assets"),
      version: CATALOG_VERSION,
    });

    expect(manifest.catalogVersion).toBe(CATALOG_VERSION);
    expect(manifest.assets.map((asset) => asset.path)).toEqual([
      "assets/hdri/loft.exr",
      "assets/images/fuzzies/fuzzy-01.png",
      "assets/project-images/alpha.webp",
      "assets/project-images/zebra.webp",
    ]);
    expect(manifest.assets[1]).toMatchObject({
      kind: "collectionImage",
      collectionId: "fuzzies",
    });
  });

  it("rejects empty asset lists", async () => {
    const { buildArtifactManifest } = await loadArtifactManifestModule();
    const root = makeTempDir();
    mkdirSync(resolve(root, "assets"), { recursive: true });

    await expect(
      buildArtifactManifest({
        source: resolve(root, "assets"),
        version: CATALOG_VERSION,
      }),
    ).rejects.toThrow(/at least one asset/);
  });

  it("rejects unsupported and unsafe artifact paths", async () => {
    const { buildArtifactManifest } = await loadArtifactManifestModule();
    const unsupported = writeCompleteArtifactSource();
    writeAsset(unsupported, "project-images/notes.txt", "notes");

    await expect(
      buildArtifactManifest({
        source: unsupported,
        version: CATALOG_VERSION,
      }),
    ).rejects.toThrow(/Unsupported project image extension/);

    const stray = writeCompleteArtifactSource();
    writeAsset(stray, "README.md", "notes");

    await expect(
      buildArtifactManifest({ source: stray, version: CATALOG_VERSION }),
    ).rejects.toThrow(/must match assets\/hdri/);
  });

  it("publishes artifacts and manifest without latest.json", async () => {
    const { publishArtifacts } = await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const remote = makeArtifactFetch();

    const result = await publishArtifacts({
      source,
      fetchImpl: remote.fetchImpl,
      baseUrl: BASE_URL,
      now: new Date("2026-05-21T12:15:30.123Z"),
    });

    expect(result.version).toBe(CATALOG_VERSION);
    expect(remote.puts).toHaveLength(15);
    expect(remote.puts.map((put) => put.path)).toContain(
      `${CATALOG_VERSION}/assets/project-images/memory-01.webp`,
    );
    expect(remote.puts.at(-1)?.path).toBe(`${CATALOG_VERSION}/manifest.json`);
    expect(remote.puts.map((put) => put.path)).toContain(
      `${CATALOG_VERSION}/assets/hdri/studio_soft.exr`,
    );
    expect(remote.puts.map((put) => put.path)).not.toContain("latest.json");
    expect(remote.puts.every((put) => put.ifNoneMatch === "*")).toBe(true);
  });

  it("publishes artifacts with an explicit version", async () => {
    const { publishArtifacts } = await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const remote = makeArtifactFetch();
    const version = "20260522T121530123Z";

    const result = await publishArtifacts({
      source,
      fetchImpl: remote.fetchImpl,
      baseUrl: BASE_URL,
      now: new Date("2026-05-21T12:15:30.123Z"),
      version,
    });

    expect(result.version).toBe(version);
    expect(remote.puts[0].path.startsWith(`${version}/`)).toBe(true);
  });

  it("resumes partial artifact publishes with matching existing assets", async () => {
    const { buildArtifactManifest, publishArtifacts } =
      await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const manifest = await buildArtifactManifest({
      source,
      version: CATALOG_VERSION,
    });
    const existing = manifest.assets[0];
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/${existing.path}`]: {
        body: readFileSync(resolve(dirname(source), existing.path), "utf8"),
        contentLength: existing.byteSize,
        contentType: "application/octet-stream",
        sha256: existing.sha256,
      },
    });

    await publishArtifacts({
      source,
      fetchImpl: remote.fetchImpl,
      baseUrl: BASE_URL,
      now: new Date("2026-05-21T12:15:30.123Z"),
    });

    expect(remote.puts.map((put) => put.path)).not.toContain(
      `${CATALOG_VERSION}/${existing.path}`,
    );
    expect(remote.puts).toHaveLength(manifest.assets.length);
    expect(remote.puts.at(-1)?.path).toBe(`${CATALOG_VERSION}/manifest.json`);
  });

  it("fails project publish when any remote target already exists", async () => {
    const { publishArtifacts } = await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/assets/project-images/memory-01.webp`]:
        storedArtifact("exists"),
    });

    await expect(
      publishArtifacts({
        source,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
        now: new Date("2026-05-21T12:15:30.123Z"),
      }),
    ).rejects.toThrow(/mismatch/);
    expect(remote.puts).toEqual([]);
  });

  it("treats a matching existing artifact manifest as already published", async () => {
    const { buildArtifactManifest, publishArtifacts } =
      await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const manifest = await buildArtifactManifest({
      source,
      version: CATALOG_VERSION,
    });
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact(
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    });

    await expect(
      publishArtifacts({
        source,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
        now: new Date("2026-05-21T12:15:30.123Z"),
      }),
    ).resolves.toMatchObject({ version: CATALOG_VERSION });
    expect(remote.puts).toEqual([]);
  });

  it("fails when an existing artifact manifest differs", async () => {
    const { publishArtifacts } = await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const remote = makeArtifactFetch({
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact("{}\n"),
    });

    await expect(
      publishArtifacts({
        source,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
        now: new Date("2026-05-21T12:15:30.123Z"),
      }),
    ).rejects.toThrow(/different content/);
    expect(remote.puts).toEqual([]);
  });

  it("retries transient artifact publish errors", async () => {
    const { publishArtifacts } = await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const remote = makeArtifactFetch();
    let failures = 2;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD" && failures > 0) {
        failures -= 1;
        return Promise.resolve(
          new Response("try again", {
            status: 503,
            statusText: "Service Unavailable",
          }),
        );
      }
      return remote.fetchImpl(input, init);
    }) as unknown as typeof fetch;

    await expect(
      publishArtifacts({
        source,
        fetchImpl,
        baseUrl: BASE_URL,
        now: new Date("2026-05-21T12:15:30.123Z"),
      }),
    ).resolves.toMatchObject({ version: CATALOG_VERSION });
    expect(failures).toBe(0);
  });

  it("includes Artifactory response bodies in artifact publish errors", async () => {
    const { publishArtifacts } = await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const remote = makeArtifactFetch();
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return Promise.resolve(
          new Response("permission denied by repository policy", {
            status: 403,
            statusText: "Forbidden",
          }),
        );
      }
      return remote.fetchImpl(input, init);
    }) as unknown as typeof fetch;

    await expect(
      publishArtifacts({
        source,
        fetchImpl,
        baseUrl: BASE_URL,
        now: new Date("2026-05-21T12:15:30.123Z"),
      }),
    ).rejects.toThrow(/permission denied by repository policy/);
  });

  it("promote validates remote artifacts before writing latest.json", async () => {
    const { buildArtifactManifest, promoteArtifacts } =
      await loadArtifactManifestModule();
    const source = writeCompleteArtifactSource();
    const manifest = await buildArtifactManifest({
      source,
      version: CATALOG_VERSION,
    });
    const artifacts: Record<string, StoredArtifact> = {
      [`${CATALOG_VERSION}/manifest.json`]: storedJsonArtifact(
        JSON.stringify(manifest),
      ),
    };
    for (const asset of manifest.assets) {
      artifacts[`${CATALOG_VERSION}/${asset.path}`] = {
        body: readFileSync(resolve(dirname(source), asset.path), "utf8"),
        contentLength: asset.byteSize,
        contentType: "application/octet-stream",
        sha256: asset.sha256,
      };
    }
    const remote = makeArtifactFetch(artifacts);

    await expect(
      promoteArtifacts({
        version: CATALOG_VERSION,
        fetchImpl: remote.fetchImpl,
        baseUrl: BASE_URL,
      }),
    ).resolves.toEqual({
      catalogVersion: CATALOG_VERSION,
      manifestPath: `${CATALOG_VERSION}/manifest.json`,
    });
    expect(remote.puts).toHaveLength(1);
    expect(remote.puts[0].path).toBe("latest.json");
  });
});
