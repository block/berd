import { convertFileSrc, invoke } from "@tauri-apps/api/core";

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
  const match = artifacts.assets.find(
    (asset) =>
      asset.kind === "collectionImage" &&
      avatarIdFromArtifactPath(asset.path) === avatarId,
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
