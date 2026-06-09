import { useQuery } from "@tanstack/react-query";
import { getChangedFiles } from "@/shared/api/git";

export function useChangedFiles(
  path: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["changed-files", path],
    queryFn: () => getChangedFiles(path ?? ""),
    enabled: enabled && Boolean(path),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // "always" rather than true: with an infinite staleTime, plain `true`
    // never fires because the data is never considered stale.
    refetchOnWindowFocus: "always",
  });
}
