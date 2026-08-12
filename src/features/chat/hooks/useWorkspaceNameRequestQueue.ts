import { useCallback, useReducer, useRef } from "react";

import type { WorkspaceNameRequest } from "@/features/chat/lib/firstWorkspaceSend";

/** Serializes workspace-name prompts so concurrent first sends cannot overwrite one another. */
export function useWorkspaceNameRequestQueue(): {
  workspaceNameRequest: WorkspaceNameRequest | null;
  enqueueWorkspaceNameRequest: (request: WorkspaceNameRequest) => void;
  cancelWorkspaceNameRequest: () => void;
  submitWorkspaceNameRequest: (name: string | null) => void;
} {
  const requestsRef = useRef<WorkspaceNameRequest[]>([]);
  const [, renderNextRequest] = useReducer((version: number) => version + 1, 0);

  const enqueueWorkspaceNameRequest = useCallback(
    (request: WorkspaceNameRequest) => {
      requestsRef.current = [...requestsRef.current, request];
      renderNextRequest();
    },
    [],
  );

  const settleCurrentRequest = useCallback(
    (settle: (request: WorkspaceNameRequest) => void) => {
      const [request, ...remaining] = requestsRef.current;
      if (!request) return;
      requestsRef.current = remaining;
      settle(request);
      renderNextRequest();
    },
    [],
  );

  const cancelWorkspaceNameRequest = useCallback(() => {
    settleCurrentRequest((request) => request.cancel());
  }, [settleCurrentRequest]);

  const submitWorkspaceNameRequest = useCallback(
    (name: string | null) => {
      settleCurrentRequest((request) => request.submit(name));
    },
    [settleCurrentRequest],
  );

  return {
    workspaceNameRequest: requestsRef.current[0] ?? null,
    enqueueWorkspaceNameRequest,
    cancelWorkspaceNameRequest,
    submitWorkspaceNameRequest,
  };
}
