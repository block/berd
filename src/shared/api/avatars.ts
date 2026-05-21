import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  mediaTypeFromMimeType,
  parseAvatarCatalog,
  type AvatarCatalog,
  type CachedAvatar,
  type CachedAvatarCollection,
  type ResolvedAvatarMedia,
} from "@/shared/avatars/catalog";

export interface AvatarLibrarySnapshot {
  catalog: AvatarCatalog;
  cachedCollections: CachedAvatarCollection[];
}

export interface EnsuredAvatarCollection extends CachedAvatarCollection {
  failedAssetIds: string[];
}

interface RawAvatarLibrarySnapshot {
  catalog: unknown;
  cachedCollections: CachedAvatarCollection[];
}

export async function getAvatarLibrarySnapshot(): Promise<AvatarLibrarySnapshot> {
  const snapshot = await invoke<RawAvatarLibrarySnapshot>(
    "get_avatar_library_snapshot",
  );

  return {
    catalog: parseAvatarCatalog(snapshot.catalog),
    cachedCollections: snapshot.cachedCollections,
  };
}

export async function getAvatarCatalog(): Promise<AvatarCatalog> {
  return (await getAvatarLibrarySnapshot()).catalog;
}

export async function getCachedAvatarCollections(_options?: {
  catalog?: AvatarCatalog;
}): Promise<CachedAvatarCollection[]> {
  return (await getAvatarLibrarySnapshot()).cachedCollections;
}

export async function ensureAvatarCollection({
  catalogVersion,
  collectionId,
}: {
  catalogVersion?: string;
  collectionId: string;
}): Promise<EnsuredAvatarCollection> {
  const resolvedCatalogVersion =
    catalogVersion ?? (await getAvatarLibrarySnapshot()).catalog.catalogVersion;

  return invoke("ensure_avatar_collection", {
    catalogVersion: resolvedCatalogVersion,
    collectionId,
  });
}

export async function getCachedAvatarForRef({
  avatarRef,
}: {
  avatarRef: string;
}): Promise<CachedAvatar | null> {
  return invoke("get_cached_avatar_for_ref", {
    avatarRef,
  });
}

export function cachedAssetToMedia(asset: {
  path: string;
  mimeType: string;
}): ResolvedAvatarMedia {
  return {
    src: convertFileSrc(asset.path, "asset"),
    mediaType: mediaTypeFromMimeType(asset.mimeType),
  };
}
