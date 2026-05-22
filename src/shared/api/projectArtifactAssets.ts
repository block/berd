import { convertFileSrc, invoke } from "@tauri-apps/api/core";

interface RawProjectArtifactAssets {
  catalogVersion: string;
  imagePaths: string[];
  environmentPath: string;
}

export interface ProjectArtifactAssets {
  catalogVersion: string;
  imageUrls: string[];
  environmentUrl: string;
}

export async function getProjectArtifactAssets(): Promise<ProjectArtifactAssets> {
  const assets = await invoke<RawProjectArtifactAssets>(
    "get_project_artifact_assets",
  );

  return {
    catalogVersion: assets.catalogVersion,
    imageUrls: assets.imagePaths.map((path) => convertFileSrc(path, "asset")),
    environmentUrl: convertFileSrc(assets.environmentPath, "asset"),
  };
}
