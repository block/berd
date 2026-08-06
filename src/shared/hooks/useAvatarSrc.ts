import { useCallback, useContext, useMemo } from "react";
import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from "@tanstack/react-query";
import { selectAvatarImageUrl } from "@/shared/api/artifacts";
import {
  avatarCachedRefQueryKey,
  cachedAssetToMedia,
  getCachedAvatarForRef,
} from "@/shared/api/avatars";
import {
  isAppAvatarRef,
  isUserAvatarRef,
  parseAvatarRef,
} from "@/shared/avatars/catalog";
import { resolveAvatarMedia, resolveAvatarSrc } from "@/shared/lib/avatarUrl";
import type { Avatar } from "@/shared/types/agents";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
import { useArtifacts } from "./useArtifacts";

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
  const avatarImageQuery = useArtifacts({
    enabled: Boolean(avatarId && !directUrl),
    select: (artifacts) =>
      avatarId ? selectAvatarImageUrl(artifacts, avatarId) : undefined,
  });

  if (directUrl) return directUrl;
  if (!avatarId) return undefined;
  return avatarImageQuery.data;
}

// Only used when a component mounts without a QueryClientProvider (some
// tests do); `enabled` is false in that case so it never fetches — it just
// keeps the unconditional useQuery call legal.
let fallbackQueryClient: QueryClient | null = null;
function getFallbackQueryClient(): QueryClient {
  fallbackQueryClient ??= new QueryClient();
  return fallbackQueryClient;
}

export function useAvatarMediaState(
  avatar: Avatar | null | undefined,
): AvatarMediaState {
  const queryClient = useContext(QueryClientContext);
  const directMedia = useMemo(() => resolveAvatarMedia(avatar), [avatar]);
  const avatarRef = typeof avatar === "string" ? avatar.trim() : "";
  // User-avatar refs (generated gloopies) resolve through the same cached
  // lookup as bundled app-avatar refs.
  const shouldLoadCachedAvatar =
    !directMedia && (isAppAvatarRef(avatarRef) || isUserAvatarRef(avatarRef));
  const enabled = shouldLoadCachedAvatar && Boolean(queryClient);

  // Reactive observer on the shared per-ref cache entry: when the app-level
  // `LocalMediaCacheEvents` listener resets these keys on cache-cleared /
  // cache-warmed events, every mounted tile refetches automatically. Tiles
  // themselves no longer register per-mount IPC event subscriptions.
  const cachedAvatarQuery = useQuery(
    {
      queryKey: avatarCachedRefQueryKey(avatarRef),
      queryFn: async () => {
        try {
          return await getCachedAvatarForRef({ avatarRef });
        } catch (error) {
          console.warn("Failed to resolve avatar asset:", error);
          throw error;
        }
      },
      enabled,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    queryClient ?? getFallbackQueryClient(),
  );

  const retry = useCallback(() => {
    if (!queryClient || !shouldLoadCachedAvatar) {
      return;
    }
    // Reset (not invalidate) so the tile blanks and shows its loading state
    // while the lookup re-runs, matching the cleared/warmed event behavior.
    void queryClient.resetQueries({
      queryKey: avatarCachedRefQueryKey(avatarRef),
    });
  }, [avatarRef, queryClient, shouldLoadCachedAvatar]);

  const remoteMedia = useMemo(
    () =>
      cachedAvatarQuery.data
        ? cachedAssetToMedia(cachedAvatarQuery.data.asset)
        : undefined,
    [cachedAvatarQuery.data],
  );

  // A cached `null` ("not cached yet") is a valid success value, so on a
  // remount within gcTime the query starts at data === null while a
  // background refetch re-checks the ref. Report that re-check as loading
  // rather than unavailable so the tile keeps its loading state until the
  // lookup settles, as the pre-query implementation did.
  const recheckingWithoutData =
    cachedAvatarQuery.isFetching && !cachedAvatarQuery.data;

  return {
    media: directMedia ?? remoteMedia,
    loading: enabled && (cachedAvatarQuery.isPending || recheckingWithoutData),
    unavailable:
      (shouldLoadCachedAvatar && !queryClient) ||
      (enabled &&
        !recheckingWithoutData &&
        (cachedAvatarQuery.data === null || cachedAvatarQuery.isError)),
    retry,
  };
}
