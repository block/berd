import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import {
  cachedAssetToMedia,
  getCachedAvatarForRef,
} from "@/shared/api/avatars";
import { listenLocalMediaCachesCleared } from "@/shared/api/localMediaCaches";
import { isAppAvatarRef } from "@/shared/avatars/catalog";
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
