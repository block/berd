import { useQuery } from "@tanstack/react-query";
import { getGitState } from "@/shared/api/git";

export function useGitState(path: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["git-state", path],
    queryFn: () => getGitState(path ?? ""),
    enabled: enabled && Boolean(path),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // Branch state changes outside the app (terminal, other windows), so
    // re-sync on window focus even though the data never goes stale. Plain
    // `true` would never fire with an infinite staleTime.
    refetchOnWindowFocus: "always",
  });
}
