import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { resolveAvatarId } from "@/shared/avatars/catalog";

export const ARTIFACTS_QUERY_KEY = ["artifacts"] as const;

export interface Artifact {
  kind: "environment" | "projectImage" | "collectionImage";
  path: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  collectionId?: string;
}

interface RawArtifacts {
  catalogVersion: string;
  assets: Artifact[];
}

export interface Artifacts {
  catalogVersion: string;
  assets: Artifact[];
}

export interface ProjectPreviewArtifacts {
  catalogVersion: string;
  imageUrls: string[];
  environmentUrl: string;
}

export async function getArtifacts(): Promise<Artifacts> {
  return invoke<RawArtifacts>("get_artifacts");
}

function avatarIdFromArtifactPath(path: string): string | undefined {
  const filename = path.split("/").pop();
  if (!filename) return undefined;
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

/**
 * Look up the local file URL for the static collection image whose filename
 * matches the given avatar id (e.g. `fuzzies-1` → `assets/images/fuzzies/fuzzies-1.png`).
 * Returns undefined when the artifacts catalog isn't loaded yet or no matching
 * asset exists.
 */
export function selectCollectionImageUrl(
  artifacts: Artifacts | null | undefined,
  collectionId: string,
  imageId: string,
): string | undefined {
  if (!artifacts) return undefined;
  // A retired avatar may move to a different collection. Never return its
  // old cached image, even while the artifacts catalog is stale/offline.
  if (
    resolveAvatarId(imageId) !== imageId &&
    collectionId === imageId.split("-")[0]
  ) {
    return selectAvatarImageUrl(artifacts, imageId);
  }
  const match = artifacts.assets.find(
    (asset) =>
      asset.kind === "collectionImage" &&
      asset.collectionId === collectionId &&
      avatarIdFromArtifactPath(asset.path) === imageId,
  );
  return match ? convertFileSrc(match.path, "asset") : undefined;
}

export function selectAvatarImageUrl(
  artifacts: Artifacts | null | undefined,
  avatarId: string,
): string | undefined {
  if (!artifacts) return undefined;
  const resolvedId = resolveAvatarId(avatarId);
  const match = artifacts.assets.find(
    (asset) =>
      asset.kind === "collectionImage" &&
      avatarIdFromArtifactPath(asset.path) === resolvedId,
  );
  return match ? convertFileSrc(match.path, "asset") : undefined;
}

export function selectProjectPreviewArtifacts(
  artifacts: Artifacts,
): ProjectPreviewArtifacts | null {
  const environment = artifacts.assets.find(
    (asset) => asset.kind === "environment",
  );
  const images = artifacts.assets.filter(
    (asset) => asset.kind === "projectImage",
  );

  if (!environment || images.length === 0) {
    return null;
  }

  return {
    catalogVersion: artifacts.catalogVersion,
    imageUrls: images.map((asset) => convertFileSrc(asset.path, "asset")),
    environmentUrl: convertFileSrc(environment.path, "asset"),
  };
}
