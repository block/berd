import { useCallback } from "react";

export function useCreatePersonaNavigation(
  onStartAgentBuilderSession: (args?: { path?: string; slug?: string }) => void,
) {
  return useCallback(() => {
    onStartAgentBuilderSession({});
  }, [onStartAgentBuilderSession]);
}
