import { useCallback } from "react";

export function useCreatePersonaNavigation(
  onStartAgentBuilderSession: (args?: { slug?: string }) => void,
) {
  return useCallback(() => {
    onStartAgentBuilderSession({});
  }, [onStartAgentBuilderSession]);
}
