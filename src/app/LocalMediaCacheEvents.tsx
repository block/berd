import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ARTIFACTS_QUERY_KEY } from "@/shared/api/artifacts";
import {
  AVATAR_CACHED_REF_QUERY_KEY_PREFIX,
  avatarCachedRefQueryKey,
  listenAvatarCacheWarmed,
} from "@/shared/api/avatars";
import { listenLocalMediaCachesCleared } from "@/shared/api/localMediaCaches";

/**
 * Single app-level subscriber for local media cache events. Cache
 * invalidation happens here against shared react-query keys — mounted
 * consumers (artifact queries, per-ref avatar tiles) observe those keys and
 * refetch automatically, so they don't each register their own IPC event
 * subscriptions.
 */
export function LocalMediaCacheEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Event registration is async and can fail; settle each subscription to a
    // no-op cleanup so a failure is logged instead of surfacing as an
    // unhandled rejection (both while mounted and via the cleanup's `.then`).
    const subscribe = (
      registration: Promise<() => void>,
      label: string,
    ): Promise<() => void> =>
      registration.catch((error: unknown) => {
        console.error(`Failed to subscribe to ${label} events:`, error);
        return () => {};
      });

    const unlisten = subscribe(
      listenLocalMediaCachesCleared((payload) => {
        if (payload.artifacts) {
          void queryClient.invalidateQueries({
            queryKey: ARTIFACTS_QUERY_KEY,
          });
        }
        if (payload.avatars) {
          // Reset (not invalidate) so tiles drop the now-deleted asset paths
          // and show their loading state while the lookup re-runs.
          void queryClient.resetQueries({
            queryKey: AVATAR_CACHED_REF_QUERY_KEY_PREFIX,
          });
        }
      }),
      "local-media-caches-cleared",
    );
    const unlistenWarmed = subscribe(
      listenAvatarCacheWarmed((payload) => {
        for (const avatarRef of payload.avatarRefs) {
          void queryClient.resetQueries({
            queryKey: avatarCachedRefQueryKey(avatarRef),
          });
        }
      }),
      "avatar-cache-warmed",
    );

    return () => {
      void unlisten.then((cleanup) => cleanup());
      void unlistenWarmed.then((cleanup) => cleanup());
    };
  }, [queryClient]);

  return null;
}
