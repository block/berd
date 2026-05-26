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
