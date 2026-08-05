import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

export type AvatarLibraryErrorCode = "networkAccess" | "unavailable";

export class AvatarLibraryError extends Error {
  code: AvatarLibraryErrorCode;

  constructor(message: string, code: AvatarLibraryErrorCode) {
    super(message);
    this.name = "AvatarLibraryError";
    this.code = code;
  }
}

interface RawAvatarLibrarySnapshot {
  catalog: unknown;
  cachedCollections: CachedAvatarCollection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAvatarLibraryErrorCode(
  value: unknown,
): value is AvatarLibraryErrorCode {
  return value === "networkAccess" || value === "unavailable";
}

function fallbackAvatarLibraryErrorMessage(code: AvatarLibraryErrorCode) {
  return code === "networkAccess"
    ? "Unable to load avatar library. Check your network connection and try again."
    : "Avatar library unavailable. Try again.";
}

export function normalizeAvatarLibraryError(
  error: unknown,
): AvatarLibraryError {
  if (error instanceof AvatarLibraryError) {
    return error;
  }

  if (isRecord(error) && isAvatarLibraryErrorCode(error.code)) {
    const message =
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : fallbackAvatarLibraryErrorMessage(error.code);
    return new AvatarLibraryError(message, error.code);
  }

  if (error instanceof Error) {
    return new AvatarLibraryError(
      error.message || fallbackAvatarLibraryErrorMessage("unavailable"),
      "unavailable",
    );
  }

  if (typeof error === "string" && error.length > 0) {
    return new AvatarLibraryError(error, "unavailable");
  }

  return new AvatarLibraryError(
    fallbackAvatarLibraryErrorMessage("unavailable"),
    "unavailable",
  );
}

export async function getAvatarLibrarySnapshot(): Promise<AvatarLibrarySnapshot> {
  let snapshot: RawAvatarLibrarySnapshot;
  try {
    snapshot = await invoke<RawAvatarLibrarySnapshot>(
      "get_avatar_library_snapshot",
    );
  } catch (error) {
    throw normalizeAvatarLibraryError(error);
  }

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

  try {
    return await invoke("ensure_avatar_collection", {
      catalogVersion: resolvedCatalogVersion,
      collectionId,
    });
  } catch (error) {
    throw normalizeAvatarLibraryError(error);
  }
}

type CachedAvatarBatchResult = Record<string, CachedAvatar | null | undefined>;

interface PendingCachedAvatarRequest {
  resolve: (avatar: CachedAvatar | null) => void;
  reject: (error: AvatarLibraryError) => void;
}

let pendingCachedAvatarRequests = new Map<
  string,
  PendingCachedAvatarRequest[]
>();
let cachedAvatarBatchScheduled = false;

function scheduleCachedAvatarBatch(): void {
  if (cachedAvatarBatchScheduled) {
    return;
  }

  cachedAvatarBatchScheduled = true;
  queueMicrotask(() => {
    const pending = pendingCachedAvatarRequests;
    pendingCachedAvatarRequests = new Map();
    cachedAvatarBatchScheduled = false;

    void getCachedAvatarsForRefs({
      avatarRefs: [...pending.keys()],
    })
      .then((avatarsByRef) => {
        for (const [avatarRef, requests] of pending) {
          const avatar = avatarsByRef[avatarRef] ?? null;
          for (const request of requests) {
            request.resolve(avatar);
          }
        }
      })
      .catch((error) => {
        const normalizedError = normalizeAvatarLibraryError(error);
        for (const requests of pending.values()) {
          for (const request of requests) {
            request.reject(normalizedError);
          }
        }
      });
  });
}

export async function getCachedAvatarsForRefs({
  avatarRefs,
}: {
  avatarRefs: string[];
}): Promise<CachedAvatarBatchResult> {
  if (avatarRefs.length === 0) {
    return {};
  }

  try {
    return await invoke("get_cached_avatars_for_refs", {
      avatarRefs,
    });
  } catch (error) {
    throw normalizeAvatarLibraryError(error);
  }
}

export async function getCachedAvatarForRef({
  avatarRef,
}: {
  avatarRef: string;
}): Promise<CachedAvatar | null> {
  return new Promise<CachedAvatar | null>((resolve, reject) => {
    const requests = pendingCachedAvatarRequests.get(avatarRef) ?? [];
    requests.push({ resolve, reject });
    pendingCachedAvatarRequests.set(avatarRef, requests);
    scheduleCachedAvatarBatch();
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

export const AVATAR_CACHE_WARMED_EVENT = "berd:avatar-cache-warmed";
export const AVATAR_CACHED_REF_QUERY_KEY_PREFIX = [
  "avatars",
  "cached-ref",
] as const;

export interface AvatarCacheWarmedPayload {
  avatarRefs: string[];
}

export function avatarCachedRefQueryKey(avatarRef: string) {
  return [...AVATAR_CACHED_REF_QUERY_KEY_PREFIX, avatarRef] as const;
}

export function listenAvatarCacheWarmed(
  handler: (payload: AvatarCacheWarmedPayload) => void,
) {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<AvatarCacheWarmedPayload>(AVATAR_CACHE_WARMED_EVENT, (event) =>
    handler(event.payload),
  );
}
