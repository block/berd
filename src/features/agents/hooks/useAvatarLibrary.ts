import { useCallback, useEffect, useState } from "react";
import {
  cachedAssetToMedia,
  getAvatarLibrarySnapshot,
  listenAvatarCacheWarmed,
  listenUserAvatarLibraryChanged,
  normalizeAvatarLibraryError,
  refreshAvatarCache,
  type AvatarLibraryErrorCode,
} from "@/shared/api/avatars";
import {
  USER_AVATAR_CATALOG_VERSION,
  USER_AVATAR_COLLECTION_ID,
  type AvatarCatalog,
  type CachedAvatarCollection,
  type ResolvedAvatarMedia,
} from "@/shared/avatars/catalog";

interface CachedAvatarMediaEntry {
  catalogVersion: string;
  media: ResolvedAvatarMedia;
}

export interface AvatarLibraryState {
  catalog: AvatarCatalog | null;
  /**
   * Ids of the user's generated gloopies (newest first). They are local
   * library citizens prepended to the published Gloopies collection and
   * persisted on agents as `user-avatar:<id>`. Their media remains separate
   * from the bundled cache so the two durable ref namespaces cannot collide.
   */
  userAvatarIds: string[];
  userAvatarMediaById: Record<string, ResolvedAvatarMedia>;
  cachedAvatarMediaById: Record<string, CachedAvatarMediaEntry>;
  loading: boolean;
  cacheChecking: boolean;
  error: boolean;
  errorCode: AvatarLibraryErrorCode | null;
  mediaError: boolean;
  mediaErrorCode: AvatarLibraryErrorCode | null;
  retryCatalog: () => void;
  retryMedia: () => void;
}

function cachedMediaForCatalog(
  collections: CachedAvatarCollection[],
  catalogVersion: string,
): Record<string, CachedAvatarMediaEntry> {
  const mediaById: Record<string, CachedAvatarMediaEntry> = {};
  for (const collection of collections) {
    if (
      collection.collectionId === USER_AVATAR_COLLECTION_ID ||
      collection.catalogVersion !== catalogVersion
    ) {
      continue;
    }
    for (const asset of collection.assets) {
      mediaById[asset.id] = {
        catalogVersion: collection.catalogVersion,
        media: cachedAssetToMedia(asset),
      };
    }
  }
  return mediaById;
}

function userAvatarMediaForCollections(
  collections: CachedAvatarCollection[],
): Record<string, ResolvedAvatarMedia> {
  const mediaById: Record<string, ResolvedAvatarMedia> = {};
  const collection = collections.find(
    (candidate) =>
      candidate.collectionId === USER_AVATAR_COLLECTION_ID &&
      candidate.catalogVersion === USER_AVATAR_CATALOG_VERSION,
  );
  for (const asset of collection?.assets ?? []) {
    mediaById[asset.id] = cachedAssetToMedia(asset);
  }
  return mediaById;
}

function userAvatarIdsForCollections(
  collections: CachedAvatarCollection[],
): string[] {
  return (
    collections
      .find(
        (collection) => collection.collectionId === USER_AVATAR_COLLECTION_ID,
      )
      ?.assets.map((asset) => asset.id) ?? []
  );
}

export function useAvatarLibrary(enabled: boolean): AvatarLibraryState {
  const [catalog, setCatalog] = useState<AvatarCatalog | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<AvatarLibraryErrorCode | null>(
    null,
  );
  const [mediaError, setMediaError] = useState(false);
  const [mediaErrorCode, setMediaErrorCode] =
    useState<AvatarLibraryErrorCode | null>(null);
  const [mediaRefreshing, setMediaRefreshing] = useState(false);
  const [backendMediaRefreshing, setBackendMediaRefreshing] = useState(false);
  const [cachedAvatarMediaById, setCachedAvatarMediaById] = useState<
    Record<string, CachedAvatarMediaEntry>
  >({});
  const [userAvatarIds, setUserAvatarIds] = useState<string[]>([]);
  const [userAvatarMediaById, setUserAvatarMediaById] = useState<
    Record<string, ResolvedAvatarMedia>
  >({});

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const reload = () => {
      if (!cancelled) {
        setReloadToken((value) => value + 1);
      }
    };

    void Promise.allSettled([
      listenAvatarCacheWarmed(reload),
      listenUserAvatarLibraryChanged(reload),
    ]).then((registrations) => {
      for (const registration of registrations) {
        if (registration.status === "rejected") {
          console.warn(
            "Failed to subscribe to avatar library changes:",
            registration.reason,
          );
          continue;
        }
        if (cancelled) {
          registration.value();
        } else {
          unlisteners.push(registration.value);
        }
      }
      // Close the snapshot/subscription gap: mutations emitted before listener
      // registration completed are recovered by one post-subscribe read.
      reload();
    });

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    void reloadToken;
    const loadAvatarLibrary = async () => {
      setLoading(true);
      try {
        const snapshot = await getAvatarLibrarySnapshot();
        if (cancelled) {
          return;
        }
        const cachedMedia = cachedMediaForCatalog(
          snapshot.cachedCollections,
          snapshot.catalog.catalogVersion,
        );
        setCatalog(snapshot.catalog);
        setCachedAvatarMediaById(cachedMedia);
        setUserAvatarIds(
          userAvatarIdsForCollections(snapshot.cachedCollections),
        );
        setUserAvatarMediaById(
          userAvatarMediaForCollections(snapshot.cachedCollections),
        );
        setBackendMediaRefreshing(snapshot.mediaRefreshing);
        const hasIncompleteMedia = snapshot.cachedCollections.some(
          (collection) => collection.failedAssetIds.length > 0,
        );
        const hasMissingMedia = snapshot.catalog.assets.some(
          (asset) => !cachedMedia[asset.id],
        );
        const mediaFailed =
          (hasIncompleteMedia || hasMissingMedia) &&
          snapshot.mediaRefreshCompleted &&
          !snapshot.mediaRefreshing;
        setMediaError(mediaFailed);
        setMediaErrorCode(
          mediaFailed ? (snapshot.mediaErrorCode ?? "unavailable") : null,
        );
        setError(false);
        setErrorCode(null);
      } catch (loadError) {
        console.warn("Failed to load avatar library:", loadError);
        if (!cancelled) {
          const avatarError = normalizeAvatarLibraryError(loadError);
          setCatalog(null);
          setError(true);
          setErrorCode(avatarError.code);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadAvatarLibrary();
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadToken]);

  const retryCatalog = useCallback(() => {
    setError(false);
    setErrorCode(null);
    setReloadToken((value) => value + 1);
  }, []);

  const retryMedia = useCallback(() => {
    setMediaRefreshing(true);
    setMediaError(false);
    setMediaErrorCode(null);
    void refreshAvatarCache()
      .then(() => {
        setReloadToken((value) => value + 1);
      })
      .catch((refreshError) => {
        const avatarError = normalizeAvatarLibraryError(refreshError);
        setMediaError(true);
        setMediaErrorCode(avatarError.code);
      })
      .finally(() => setMediaRefreshing(false));
  }, []);

  return {
    catalog,
    userAvatarIds,
    userAvatarMediaById,
    cachedAvatarMediaById,
    loading,
    cacheChecking: loading || mediaRefreshing || backendMediaRefreshing,
    error,
    errorCode,
    mediaError,
    mediaErrorCode,
    retryCatalog,
    retryMedia,
  };
}
