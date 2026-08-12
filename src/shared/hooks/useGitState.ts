import { useQuery } from "@tanstack/react-query";
import { getGitState } from "@/shared/api/git";
import { gitStateQueryKey } from "@/shared/lib/gitStateQueryKey";
import { isHomeRelativePath } from "@/shared/lib/homePath";
import { useHomeDir } from "@/shared/hooks/useHomeDir";

export function useGitState(path: string | null | undefined, enabled = true) {
  const homeDir = useHomeDir();
  // Key through the shared builder so both spellings of the same directory
  // share one cache entry and one `get_git_state` call — and so the
  // chat-settled invalidation keys the same normalized path. Home-relative
  // paths wait for the (cached, one-time) home dir lookup instead of fetching
  // under a key that would immediately be replaced.
  const needsHomeDir = Boolean(path && isHomeRelativePath(path));
  const queryKey = gitStateQueryKey(path, homeDir);
  const normalizedPath = queryKey[1];
  return useQuery({
    queryKey,
    queryFn: () => getGitState(normalizedPath ?? ""),
    enabled:
      enabled && Boolean(normalizedPath) && (!needsHomeDir || homeDir !== null),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // Branch state changes outside the app (terminal, other windows), so
    // re-sync on window focus even though the data never goes stale. Plain
    // `true` would never fire with an infinite staleTime.
    refetchOnWindowFocus: "always",
  });
}
