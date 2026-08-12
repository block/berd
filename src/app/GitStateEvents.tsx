import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listenGitStateChanged } from "@/shared/api/git";

export function GitStateEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listenGitStateChanged(() => {
      void Promise.all([
        queryClient
          .invalidateQueries({ queryKey: ["git-state"] })
          .catch(() => undefined),
        queryClient
          .invalidateQueries({ queryKey: ["changed-files"] })
          .catch(() => undefined),
      ]);
    });

    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [queryClient]);

  return null;
}
