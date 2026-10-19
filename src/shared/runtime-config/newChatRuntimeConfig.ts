import { useRuntimeConfigStore } from "./runtimeConfigStore";

/** Evaluate the current source before new-chat defaults or target resolution.
 * Existing-chat navigation must not call this. Future feature-flag sources
 * belong in config resolution, not in individual chat entry points.
 */
export function refreshRuntimeConfigForNewChat() {
  return useRuntimeConfigStore.getState().refreshForNewChat();
}
