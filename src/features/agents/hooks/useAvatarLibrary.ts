import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cachedAssetToMedia,
  ensureAvatarCollection,
  getAvatarCatalog,
  getCachedAvatarCollections,
  normalizeAvatarLibraryError,
  type AvatarLibraryErrorCode,
} from "@/shared/api/avatars";
import type {
  AvatarCatalog,
  AvatarCollection,
  CachedAvatarCollection,
  ResolvedAvatarMedia,
} from "@/shared/avatars/catalog";

interface CachedAvatarMediaEntry {
  catalogVersion: string;
  media: ResolvedAvatarMedia;
}

const AVATAR_LIBRARY_STALE_TIME_MS = 24 * 60 * 60 * 1000;

export interface AvatarLibraryState {
  catalog: AvatarCatalog | null;
  cachedAvatarMediaById: Record<string, CachedAvatarMediaEntry>;
  loading: boolean;
  cacheChecking: boolean;
  error: boolean;
  errorCode: AvatarLibraryErrorCode | null;
  downloadingCollectionIds: Set<string>;
  failedCollectionIds: Set<string>;
  retryCatalog: () => void;
  openCollection: (collection: AvatarCollection) => Promise<void>;
  isCollectionCached: (collection: AvatarCollection) => boolean;
}

function mergeCachedCollectionsForCatalog(
  current: Record<string, CachedAvatarMediaEntry>,
  collections: CachedAvatarCollection[],
  catalogVersion: string,
): Record<string, CachedAvatarMediaEntry> {
  const next = { ...current };
  for (const collection of collections) {
    if (collection.catalogVersion !== catalogVersion) {
      continue;
    }
    for (const asset of collection.assets) {
      next[asset.id] = {
        catalogVersion,
        media: cachedAssetToMedia(asset),
      };
    }
  }
  return next;
}

function hasCachedCollectionAssets({
  cachedAvatarMediaById,
  catalogVersion,
  collection,
  cachedCollection,
}: {
  cachedAvatarMediaById: Record<string, CachedAvatarMediaEntry>;
  catalogVersion: string;
  collection: AvatarCollection;
  cachedCollection: CachedAvatarCollection;
}): boolean {
  const ensuredAssetIds =
    cachedCollection.catalogVersion === catalogVersion
      ? new Set(cachedCollection.assets.map((asset) => asset.id))
      : new Set<string>();

  return collection.avatarIds.every(
    (avatarId) =>
      ensuredAssetIds.has(avatarId) ||
      cachedAvatarMediaById[avatarId]?.catalogVersion === catalogVersion,
  );
}

export function useAvatarLibrary(enabled: boolean): AvatarLibraryState {
  const [catalog, setCatalog] = useState<AvatarCatalog | null>(null);
  const [catalogRetryToken, setCatalogRetryToken] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [cacheChecking, setCacheChecking] = useState(false);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<AvatarLibraryErrorCode | null>(
    null,
  );
  const [downloadingCollectionIds, setDownloadingCollectionIds] = useState<
    Set<string>
  >(() => new Set());
  const [failedCollectionIds, setFailedCollectionIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Error reason per failed collection. Concurrent ensures (the collections
  // level warms every collection at once) each resolve independently — a
  // later success must not erase the reason an earlier collection failed,
  // so reasons live per-collection and the exposed errorCode aggregates
  // from the set that is still failed.
  const [collectionErrorCodes, setCollectionErrorCodes] = useState<
    Record<string, AvatarLibraryErrorCode>
  >({});
  const [cachedAvatarMediaById, setCachedAvatarMediaById] = useState<
    Record<string, CachedAvatarMediaEntry>
  >({});
  const catalogLoadKey = enabled ? `${catalogRetryToken}` : "disabled";
  const [previousCatalogLoadKey, setPreviousCatalogLoadKey] =
    useState(catalogLoadKey);
  if (previousCatalogLoadKey !== catalogLoadKey) {
    setPreviousCatalogLoadKey(catalogLoadKey);
    if (enabled) {
      setLoading(true);
      setCacheChecking(false);
      setError(false);
      setErrorCode(null);
    }
  }

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const interval = window.setInterval(() => {
      setCatalogRetryToken((value) => value + 1);
    }, AVATAR_LIBRARY_STALE_TIME_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: catalogRetryToken intentionally retriggers catalog loading when Retry is clicked.
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const loadCachedAvatarCollections = async (nextCatalog: AvatarCatalog) => {
      try {
        setCacheChecking(true);
        const cachedCollections = await getCachedAvatarCollections({
          catalog: nextCatalog,
        });
        if (cancelled) {
          return;
        }

        setCachedAvatarMediaById((current) =>
          mergeCachedCollectionsForCatalog(
            current,
            cachedCollections,
            nextCatalog.catalogVersion,
          ),
        );
      } catch (loadError) {
        console.warn("Failed to inspect cached avatar collections:", loadError);
      } finally {
        if (!cancelled) {
          setCacheChecking(false);
        }
      }
    };

    const loadAvatarCatalog = async () => {
      try {
        const nextCatalog = await getAvatarCatalog();
        if (!cancelled) {
          setCatalog(nextCatalog);
          setCachedAvatarMediaById({});
          setFailedCollectionIds(new Set());
          setCollectionErrorCodes({});
          setError(false);
          setErrorCode(null);
        }
        void loadCachedAvatarCollections(nextCatalog);
      } catch (loadError) {
        console.warn("Failed to load avatar catalog:", loadError);
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

    void loadAvatarCatalog();

    return () => {
      cancelled = true;
    };
  }, [catalogRetryToken, enabled]);

  const isCollectionCached = useCallback(
    (collection: AvatarCollection) =>
      collection.avatarIds.every(
        (avatarId) =>
          cachedAvatarMediaById[avatarId]?.catalogVersion ===
          catalog?.catalogVersion,
      ),
    [catalog?.catalogVersion, cachedAvatarMediaById],
  );

  const openCollection = useCallback(
    async (collection: AvatarCollection) => {
      if (!catalog) {
        return;
      }

      if (
        isCollectionCached(collection) &&
        !failedCollectionIds.has(collection.id)
      ) {
        return;
      }

      if (downloadingCollectionIds.has(collection.id)) {
        return;
      }

      setDownloadingCollectionIds((current) =>
        new Set(current).add(collection.id),
      );

      try {
        const cachedCollection = await ensureAvatarCollection({
          catalogVersion: catalog.catalogVersion,
          collectionId: collection.id,
        });
        setCachedAvatarMediaById((current) =>
          mergeCachedCollectionsForCatalog(
            current,
            [cachedCollection],
            catalog.catalogVersion,
          ),
        );
        const failedAssetIds = cachedCollection.failedAssetIds ?? [];
        const collectionCachedAfterEnsure = hasCachedCollectionAssets({
          cachedAvatarMediaById,
          catalogVersion: catalog.catalogVersion,
          collection,
          cachedCollection,
        });
        const collectionFailed =
          failedAssetIds.length > 0 || !collectionCachedAfterEnsure;
        setCollectionErrorCodes((current) => {
          if (collectionFailed) {
            return {
              ...current,
              [collection.id]: cachedCollection.errorCode ?? "unavailable",
            };
          }
          if (!(collection.id in current)) {
            return current;
          }
          const { [collection.id]: _removed, ...rest } = current;
          return rest;
        });
        setFailedCollectionIds((current) => {
          const next = new Set(current);
          if (collectionFailed) {
            next.add(collection.id);
          } else {
            next.delete(collection.id);
          }
          return next;
        });
      } catch (downloadError) {
        console.warn("Failed to download avatar collection:", downloadError);
        setCollectionErrorCodes((current) => ({
          ...current,
          [collection.id]: normalizeAvatarLibraryError(downloadError).code,
        }));
        setFailedCollectionIds((current) =>
          new Set(current).add(collection.id),
        );
      } finally {
        setDownloadingCollectionIds((current) => {
          if (!current.has(collection.id)) {
            return current;
          }
          const next = new Set(current);
          next.delete(collection.id);
          return next;
        });
      }
    },
    [
      cachedAvatarMediaById,
      catalog,
      downloadingCollectionIds,
      failedCollectionIds,
      isCollectionCached,
    ],
  );

  const retryCatalog = useCallback(() => {
    setError(false);
    setErrorCode(null);
    setCatalogRetryToken((value) => value + 1);
  }, []);

  // Aggregate download-failure reason derived only from collections that are
  // still failed, so a successful ensure can never erase the reason an
  // earlier concurrent one failed. networkAccess wins ties because the UI
  // shows actionable "check your network" guidance for it.
  const failedCollectionErrorCode = useMemo(() => {
    const codes = [...failedCollectionIds]
      .map((id) => collectionErrorCodes[id])
      .filter((code): code is AvatarLibraryErrorCode => code !== undefined);
    if (codes.includes("networkAccess")) {
      return "networkAccess";
    }
    return codes[0] ?? null;
  }, [collectionErrorCodes, failedCollectionIds]);

  return {
    catalog,
    cachedAvatarMediaById,
    loading,
    cacheChecking,
    error,
    // Catalog-level failures (nothing loaded at all) take precedence over
    // per-collection download failures.
    errorCode: errorCode ?? failedCollectionErrorCode,
    downloadingCollectionIds,
    failedCollectionIds,
    retryCatalog,
    openCollection,
    isCollectionCached,
  };
}
