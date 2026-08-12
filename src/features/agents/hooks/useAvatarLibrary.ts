import { useCallback, useEffect, useState } from "react";
import {
  cachedAssetToMedia,
  getAvatarLibrarySnapshot,
  listenAvatarCacheWarmed,
  normalizeAvatarLibraryError,
  refreshAvatarCache,
  type AvatarLibraryErrorCode,
} from "@/shared/api/avatars";
import type {
  AvatarCatalog,
  CachedAvatarCollection,
  ResolvedAvatarMedia,
} from "@/shared/avatars/catalog";

interface CachedAvatarMediaEntry {
  catalogVersion: string;
  media: ResolvedAvatarMedia;
}

export interface AvatarLibraryState {
  catalog: AvatarCatalog | null;
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
    if (collection.catalogVersion !== catalogVersion) {
      continue;
    }
    for (const asset of collection.assets) {
      mediaById[asset.id] = {
        catalogVersion,
        media: cachedAssetToMedia(asset),
      };
    }
  }
  return mediaById;
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

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const unlistenPromise = listenAvatarCacheWarmed(() => {
      if (!cancelled) {
        setReloadToken((value) => value + 1);
      }
    });

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
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
