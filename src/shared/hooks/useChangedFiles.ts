import { useQuery } from "@tanstack/react-query";
import { getChangedFiles } from "@/shared/api/git";
import { changedFilesQueryKey } from "@/shared/lib/gitStateQueryKey";
import { isHomeRelativePath } from "@/shared/lib/homePath";
import { useHomeDir } from "@/shared/hooks/useHomeDir";

export function useChangedFiles(
  path: string | null | undefined,
  enabled = true,
) {
  const homeDir = useHomeDir();
  // Key through the shared builder so `~` and absolute spellings collapse to
  // one cache entry — and so the chat-settled invalidation keys the same
  // normalized path this observer subscribes to.
  const needsHomeDir = Boolean(path && isHomeRelativePath(path));
  const queryKey = changedFilesQueryKey(path, homeDir);
  const normalizedPath = queryKey[1];
  return useQuery({
    queryKey,
    queryFn: () => getChangedFiles(normalizedPath ?? ""),
    enabled:
      enabled && Boolean(normalizedPath) && (!needsHomeDir || homeDir !== null),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // "always" rather than true: with an infinite staleTime, plain `true`
    // never fires because the data is never considered stale.
    refetchOnWindowFocus: "always",
  });
}
