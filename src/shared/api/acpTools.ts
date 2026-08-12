import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Mirrors ACP_TOOLS_RECONCILED_EVENT in
// src-tauri/src/services/acp_tools_reconciler.rs.
export const ACP_TOOLS_RECONCILED_EVENT = "berd:acp-tools-reconciled";

export interface AcpToolsReconciledPayload {
  /** False when at least one managed bridge install failed this launch. */
  ok: boolean;
  /** Provider ids of the bridges the reconciler manages (e.g. `claude-acp`). */
  providerIds: string[];
}

// Fires once per launch when the startup reconciler finishes installing or
// upgrading the managed ACP bridges — including on partial failure, since the
// bridges that did land should become selectable.
export function listenAcpToolsReconciled(
  handler: (payload: AcpToolsReconciledPayload) => void,
): Promise<UnlistenFn> {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<AcpToolsReconciledPayload>(
    ACP_TOOLS_RECONCILED_EVENT,
    (event) => handler(event.payload),
  );
}
