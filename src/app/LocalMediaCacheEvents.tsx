import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listenLocalMediaCachesCleared } from "@/shared/api/localMediaCaches";
import { PROJECT_ARTIFACT_ASSETS_QUERY_KEY } from "@/shared/api/projectArtifactAssets";

export function LocalMediaCacheEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listenLocalMediaCachesCleared((payload) => {
      if (!payload.projectArtifactAssets) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: PROJECT_ARTIFACT_ASSETS_QUERY_KEY,
      });
    });

    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [queryClient]);

  return null;
}
