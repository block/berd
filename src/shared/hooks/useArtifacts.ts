import {
  QueryClient,
  QueryClientContext,
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useContext } from "react";
import {
  ARTIFACTS_QUERY_KEY,
  getArtifacts,
  type Artifacts,
} from "@/shared/api/artifacts";

type ArtifactsQueryOptions<TData> = Pick<
  UseQueryOptions<Artifacts, Error, TData, typeof ARTIFACTS_QUERY_KEY>,
  "select" | "retry" | "retryDelay"
> & {
  enabled?: boolean;
};

const fallbackQueryClient = new QueryClient();
const ARTIFACTS_QUERY_STALE_TIME_MS = 24 * 60 * 60 * 1000;

export function useArtifacts<TData = Artifacts>(
  options: ArtifactsQueryOptions<TData> = {},
): UseQueryResult<TData, Error> {
  const queryClient = useContext(QueryClientContext);

  return useQuery<Artifacts, Error, TData, typeof ARTIFACTS_QUERY_KEY>(
    {
      queryKey: ARTIFACTS_QUERY_KEY,
      queryFn: getArtifacts,
      staleTime: ARTIFACTS_QUERY_STALE_TIME_MS,
      ...options,
      enabled: Boolean(queryClient) && (options.enabled ?? true),
    },
    queryClient ?? fallbackQueryClient,
  );
}
