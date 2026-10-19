import {
  applyRuntimeProviderConfig,
  defaultModelInventoryModeForLoadResult,
} from "@/features/providers/runtimeProviderConfig";
import type { RuntimeConfigLoadResult } from "./schema";
import { useRuntimeConfigStore } from "./runtimeConfigStore";

let pendingRefresh: Promise<RuntimeConfigLoadResult> | undefined;

/** Refresh and reconcile provider configuration before new-chat target selection.
 * Existing-chat navigation must not call this. Future feature-flag sources
 * belong in config resolution, not in individual chat entry points.
 */
export function refreshRuntimeConfigForNewChat(): Promise<RuntimeConfigLoadResult> {
  if (pendingRefresh) return pendingRefresh;
  const pending = (async () => {
    await useRuntimeConfigStore.getState().refreshForNewChat();
    return reconcileRuntimeConfigProviders();
  })();
  pendingRefresh = pending;
  // Both outcomes release the coalesced request; a failed sync can retry on
  // the next creation gesture without an unhandled rejected finally promise.
  void pending.then(
    () => {
      if (pendingRefresh === pending) pendingRefresh = undefined;
    },
    () => {
      if (pendingRefresh === pending) pendingRefresh = undefined;
    },
  );
  return pending;
}

/** Reconcile the effective snapshot without evaluating its source again.
 * Detached windows use this after loading a newer native routing revision.
 */
export async function reconcileRuntimeConfigProviders(): Promise<RuntimeConfigLoadResult> {
  for (;;) {
    const { result, config } = useRuntimeConfigStore.getState();
    await applyRuntimeProviderConfig(config, {
      defaultModelInventoryMode: defaultModelInventoryModeForLoadResult(result),
      requireBackendSync: true,
      isCurrent: () => useRuntimeConfigStore.getState().result === result,
    });
    if (useRuntimeConfigStore.getState().result === result) return result;
  }
}
