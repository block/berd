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
    refetchOnWindowFocus: true,
  });
}
