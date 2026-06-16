import type { QueryClient } from "@tanstack/react-query";

let queryClient: QueryClient | null = null;

export function registerGoosectlQueryClient(qc: QueryClient): void {
  queryClient = qc;
}

/**
 * Clears the registered query client. Pass the instance being unregistered so
 * a re-registering effect's cleanup cannot clear its successor; omit it to
 * clear unconditionally.
 */
export function clearGoosectlQueryClient(qc?: QueryClient): void {
  if (qc === undefined || queryClient === qc) {
    queryClient = null;
  }
}

export function getGoosectlQueryClient(): QueryClient | null {
  return queryClient;
}
