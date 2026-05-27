import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import {
  ARTIFACTS_QUERY_KEY,
  getArtifacts,
  selectAvatarImageUrl,
  type Artifacts,
} from "@/shared/api/artifacts";
import {
  cachedAssetToMedia,
  getCachedAvatarForRef,
} from "@/shared/api/avatars";
import { listenLocalMediaCachesCleared } from "@/shared/api/localMediaCaches";
import { isAppAvatarRef, parseAvatarRef } from "@/shared/avatars/catalog";
import { resolveAvatarMedia, resolveAvatarSrc } from "@/shared/lib/avatarUrl";
import type { Avatar } from "@/shared/types/agents";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";

export interface AvatarMediaState {
  media: ResolvedAvatarMedia | undefined;
  loading: boolean;
  unavailable: boolean;
  retry: () => void;
}

/**
 * React hook that resolves an Avatar to a displayable image URL.
 */
export function useAvatarSrc(
  avatar: Avatar | null | undefined,
): string | undefined {
  return useMemo(() => resolveAvatarSrc(avatar), [avatar]);
}

/**
 * React hook that resolves an Avatar to displayable image or video media.
 */
export function useAvatarMedia(avatar: Avatar | null | undefined) {
  return useAvatarMediaState(avatar).media;
}

/**
 * React hook that resolves an Avatar to a static image URL. For bundled
 * `app-avatar:<id>` refs it looks up the matching `collectionImage` in the
 * artifacts catalog (downloaded on startup). For remote URLs it passes
 * through. Use this instead of `useAvatarMedia` when an image is preferable
 * to the animated video variant — e.g. small surfaces where the video
 * doesn't scale down well.
 */
export function useAvatarImage(
  avatar: Avatar | null | undefined,
): string | undefined {
  const directUrl = useMemo(() => resolveAvatarSrc(avatar), [avatar]);
  const avatarRef = typeof avatar === "string" ? avatar.trim() : "";
  const avatarId = useMemo(
    () => (isAppAvatarRef(avatarRef) ? parseAvatarRef(avatarRef) : undefined),
    [avatarRef],
  );
  const queryClient = useContext(QueryClientContext);
  const [artifacts, setArtifacts] = useState<Artifacts | undefined>(() =>
    queryClient?.getQueryData<Artifacts>(ARTIFACTS_QUERY_KEY),
  );

  useEffect(() => {
    if (!avatarId || directUrl || !queryClient) return;
    let cancelled = false;
    void queryClient
      .fetchQuery({
        queryKey: ARTIFACTS_QUERY_KEY,
        queryFn: getArtifacts,
        staleTime: Number.POSITIVE_INFINITY,
      })
      .then((result) => {
        if (!cancelled) setArtifacts(result);
      })
      .catch(() => {
        // Catalog isn't available; fall back to IconRobot at the call site.
      });
    return () => {
      cancelled = true;
    };
  }, [avatarId, directUrl, queryClient]);

  if (directUrl) return directUrl;
  if (!avatarId) return undefined;
  return selectAvatarImageUrl(artifacts, avatarId);
}

export function useAvatarMediaState(
  avatar: Avatar | null | undefined,
): AvatarMediaState {
  const queryClient = useContext(QueryClientContext);
  const directMedia = useMemo(() => resolveAvatarMedia(avatar), [avatar]);
  const avatarRef = typeof avatar === "string" ? avatar.trim() : "";
  const shouldLoadCachedAvatar = !directMedia && isAppAvatarRef(avatarRef);
  const [remoteMedia, setRemoteMedia] = useState<
    ResolvedAvatarMedia | undefined
  >(undefined);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  const retry = useCallback(() => {
    setRetryToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!shouldLoadCachedAvatar) {
      return;
    }

    const unlisten = listenLocalMediaCachesCleared((payload) => {
      if (!payload.avatars) {
        return;
      }
      queryClient?.removeQueries({
        queryKey: ["avatars", "cached-ref", avatarRef],
      });
      setRemoteMedia(undefined);
      setUnavailable(false);
      setRetryToken((value) => value + 1);
    });

    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [avatarRef, queryClient, shouldLoadCachedAvatar]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryToken intentionally retriggers the same cached lookup when retry is called.
  useEffect(() => {
    if (!shouldLoadCachedAvatar) {
      setRemoteMedia(undefined);
      setLoading(false);
      setUnavailable(false);
      return;
    }

    let cancelled = false;
    setRemoteMedia(undefined);
    if (!queryClient) {
      setLoading(false);
      setUnavailable(true);
      return;
    }

    setLoading(true);
    setUnavailable(false);

    void queryClient
      .fetchQuery({
        queryKey: ["avatars", "cached-ref", avatarRef],
        queryFn: async () => {
          try {
            return await getCachedAvatarForRef({ avatarRef });
          } catch (error) {
            console.warn("Failed to resolve avatar asset:", error);
            throw error;
          }
        },
      })
      .then((cached) => {
        if (cancelled) {
          return;
        }
        setRemoteMedia(cached ? cachedAssetToMedia(cached.asset) : undefined);
        setUnavailable(cached === null);
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteMedia(undefined);
          setUnavailable(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [avatarRef, queryClient, retryToken, shouldLoadCachedAvatar]);

  return {
    media: directMedia ?? remoteMedia,
    loading,
    unavailable,
    retry,
  };
}
