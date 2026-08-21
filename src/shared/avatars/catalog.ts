export const APP_AVATAR_REF_PREFIX = "app-avatar:" as const;
export const USER_AVATAR_REF_PREFIX = "user-avatar:" as const;

/**
 * Collection id and catalog version the backend assigns to user-generated
 * gloopies (`src-tauri/src/commands/avatars.rs` mirrors these constants).
 * User gloopies live outside the published catalog, so their media entries
 * are stamped with `USER_AVATAR_CATALOG_VERSION` instead of the catalog's
 * version string.
 */
export const USER_AVATAR_COLLECTION_ID = "generated-gloopies" as const;
export const USER_AVATAR_CATALOG_VERSION = "user-generated" as const;

export type AvatarMediaType = "image" | "video";
export type AvatarAlphaMode = "stacked";
export type AvatarAssetFormat = "webm" | "hevc";

export interface AvatarVariant {
  path: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export interface AvatarCatalogEntry {
  id: string;
  label: string;
  collectionId: string;
  variants: Record<AvatarAssetFormat, AvatarVariant> & {
    poster?: AvatarVariant;
  };
}

export interface ResolvedAvatarMedia {
  src: string;
  mediaType: AvatarMediaType;
  alphaMode?: AvatarAlphaMode;
  posterSrc?: string;
}

export interface AvatarCollection {
  id: string;
  label: string;
  coverAvatarId: string;
  avatarIds: string[];
}

export interface AvatarCatalog {
  schemaVersion: 1;
  catalogVersion: string;
  collections: AvatarCollection[];
  assets: AvatarCatalogEntry[];
}

export interface CachedAvatarAsset {
  id: string;
  path: string;
  mimeType: string;
  alphaMode?: AvatarAlphaMode;
  posterPath?: string;
}

export interface CachedAvatarCollection {
  catalogVersion: string;
  collectionId: string;
  assets: CachedAvatarAsset[];
  failedAssetIds: string[];
  errorCode?: "networkAccess" | "unavailable" | null;
}

export interface CachedAvatar {
  catalogVersion: string;
  collectionId: string;
  asset: CachedAvatarAsset;
}

const APP_AVATAR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function avatarRef(id: string): string {
  return `${APP_AVATAR_REF_PREFIX}${id}`;
}

export function parseAvatarRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(APP_AVATAR_REF_PREFIX)) {
    return undefined;
  }

  const id = trimmed.slice(APP_AVATAR_REF_PREFIX.length);
  return APP_AVATAR_ID_PATTERN.test(id) ? id : undefined;
}

export function isAppAvatarRef(value: string): boolean {
  return parseAvatarRef(value) !== undefined;
}

export const isBundledAvatarRef = isAppAvatarRef;

export function userAvatarRef(id: string): string {
  return `${USER_AVATAR_REF_PREFIX}${id}`;
}

export function parseUserAvatarRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(USER_AVATAR_REF_PREFIX)) {
    return undefined;
  }

  const id = trimmed.slice(USER_AVATAR_REF_PREFIX.length);
  return APP_AVATAR_ID_PATTERN.test(id) ? id : undefined;
}

export function isUserAvatarRef(value: string): boolean {
  return parseUserAvatarRef(value) !== undefined;
}

/**
 * Whether the value references an avatar the library owns — bundled catalog
 * (`app-avatar:`) or user-generated (`user-avatar:`) — as opposed to a custom
 * URL or data URL.
 */
export function isLibraryAvatarRef(value: string): boolean {
  return isAppAvatarRef(value) || isUserAvatarRef(value);
}

export function mediaTypeFromMimeType(mimeType: string): AvatarMediaType {
  return mimeType.toLowerCase().startsWith("video/") ? "video" : "image";
}

export function getAvatarCatalogEntry(
  catalog: AvatarCatalog | null | undefined,
  id: string,
): AvatarCatalogEntry | undefined {
  return catalog?.assets.find((entry) => entry.id === id);
}

export function getAvatarCollectionForRef(
  catalog: AvatarCatalog | null | undefined,
  avatarReference: string,
): AvatarCollection | undefined {
  const avatarId = parseAvatarRef(avatarReference);
  if (!avatarId) {
    return undefined;
  }
  return catalog?.collections.find((collection) =>
    collection.avatarIds.includes(avatarId),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\0")) {
    return false;
  }

  return !value
    .split(/[\\/]/)
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function parseVariant(value: unknown): AvatarVariant | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { path, mimeType, byteSize, sha256 } = value;
  if (
    !isString(path) ||
    !isSafeRelativePath(path) ||
    !isString(mimeType) ||
    typeof byteSize !== "number" ||
    !Number.isSafeInteger(byteSize) ||
    byteSize <= 0 ||
    !isString(sha256) ||
    !/^[a-f0-9]{64}$/i.test(sha256)
  ) {
    return undefined;
  }

  return { path, mimeType, byteSize, sha256: sha256.toLowerCase() };
}

/**
 * Display-label overrides applied on top of the published catalog. The
 * catalog is versioned and republished out-of-band, so a rename would
 * otherwise wait on (and be silently reverted by) catalog pushes; overriding
 * at the parse boundary keeps every surface (overlay wordmark, cards,
 * pickers) consistent. Collection ids never change — existing
 * `app-avatar:pollies-*` refs keep resolving.
 */
const COLLECTION_LABEL_OVERRIDES: Record<string, string> = {
  // Renamed from the "Pollies" placeholder (design direction, Aug 2026).
  // Remove once the published catalog carries the new label.
  pollies: "Figgies",
};

function parseCollection(value: unknown): AvatarCollection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { id, label, coverAvatarId, avatarIds } = value;
  if (
    !isString(id) ||
    !isString(label) ||
    !isString(coverAvatarId) ||
    !APP_AVATAR_ID_PATTERN.test(coverAvatarId) ||
    !Array.isArray(avatarIds) ||
    !avatarIds.every(
      (avatarId) => isString(avatarId) && APP_AVATAR_ID_PATTERN.test(avatarId),
    )
  ) {
    return undefined;
  }

  return {
    id,
    label: COLLECTION_LABEL_OVERRIDES[id] ?? label,
    coverAvatarId,
    avatarIds,
  };
}

function parseAsset(value: unknown): AvatarCatalogEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { id, label, collectionId, variants } = value;
  if (
    !isString(id) ||
    !APP_AVATAR_ID_PATTERN.test(id) ||
    !isString(label) ||
    !isString(collectionId) ||
    !isRecord(variants)
  ) {
    return undefined;
  }

  const webm = parseVariant(variants.webm);
  const hevc = parseVariant(variants.hevc);
  const poster = parseVariant(variants.poster);
  if (!webm || !hevc || (variants.poster !== undefined && !poster)) {
    return undefined;
  }

  return {
    id,
    label,
    collectionId,
    variants: {
      webm,
      hevc,
      ...(poster ? { poster } : {}),
    },
  };
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function parseAvatarCatalog(value: unknown): AvatarCatalog {
  if (!isRecord(value)) {
    throw new Error("Avatar catalog must be an object.");
  }

  const { schemaVersion, catalogVersion, collections, assets } = value;
  if (
    schemaVersion !== 1 ||
    !isString(catalogVersion) ||
    !Array.isArray(collections) ||
    !Array.isArray(assets)
  ) {
    throw new Error("Unsupported avatar catalog schema.");
  }

  const parsedCollections = collections.map(parseCollection);
  const parsedAssets = assets.map(parseAsset);
  if (!parsedCollections.every(isDefined) || !parsedAssets.every(isDefined)) {
    throw new Error("Invalid avatar catalog contents.");
  }

  if (
    hasDuplicates(parsedCollections.map((collection) => collection.id)) ||
    hasDuplicates(parsedAssets.map((asset) => asset.id))
  ) {
    throw new Error("Invalid avatar catalog contents.");
  }

  const assetsById = new Map(parsedAssets.map((asset) => [asset.id, asset]));
  for (const collection of parsedCollections) {
    if (hasDuplicates(collection.avatarIds)) {
      throw new Error("Invalid avatar catalog contents.");
    }

    const cover = assetsById.get(collection.coverAvatarId);
    if (!cover || cover.collectionId !== collection.id) {
      throw new Error("Invalid avatar catalog contents.");
    }

    for (const avatarId of collection.avatarIds) {
      const asset = assetsById.get(avatarId);
      if (!asset || asset.collectionId !== collection.id) {
        throw new Error("Invalid avatar catalog contents.");
      }
    }
  }

  return {
    schemaVersion,
    catalogVersion,
    collections: parsedCollections,
    assets: parsedAssets,
  };
}
