import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ARTIFACTS_QUERY_KEY } from "@/shared/api/artifacts";
import { listenLocalMediaCachesCleared } from "@/shared/api/localMediaCaches";

export function LocalMediaCacheEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listenLocalMediaCachesCleared((payload) => {
      if (!payload.artifacts) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ARTIFACTS_QUERY_KEY,
      });
    });

    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [queryClient]);

  return null;
}
