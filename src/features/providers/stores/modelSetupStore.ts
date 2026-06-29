import { create } from "zustand";

import {
  clearModelSetupStatus,
  listModelSetupStatus,
  onModelSetupState,
  startModelSetup,
  type ModelSetupOperation,
  type ModelSetupPlan,
} from "@/features/providers/api/modelSetup";

// Thin, backend-backed view of model-provider native sign-in progress. Unlike
// `providerModelCacheStore` this is *not* the source of truth and is never
// persisted to localStorage — the Rust registry owns the truth. The store just
// mirrors the latest `model-setup:state` snapshot per provider so rows can be
// pure views that rehydrate instantly on (re)mount and survive a full reload.

interface ModelSetupState {
  operations: Map<string, ModelSetupOperation>;
}

interface ModelSetupActions {
  // App-level, idempotent: attach the `model-setup:state` listener and
  // rehydrate from `list_model_setup_status()`. Run once at startup (before any
  // row mounts) so reload survival works.
  init: () => Promise<void>;
  startSetup: (providerId: string, plan: ModelSetupPlan) => Promise<void>;
  getStatus: (providerId: string) => ModelSetupOperation | undefined;
  // Replace a provider's snapshot. Used by the event listener and the startup
  // rehydration.
  setOperation: (providerId: string, operation: ModelSetupOperation) => void;
  // Drop a terminal entry the row has consumed (clears the backend registry too
  // so the GC backstop has less to sweep).
  clear: (providerId: string) => void;
}

export type ModelSetupStore = ModelSetupState & ModelSetupActions;

// Module-level guard so `init` only ever attaches one listener, no matter how
// many times startup runs (StrictMode, fast re-entry).
let initialized = false;

// Per-provider revisions let `startSetup` ignore the returned seeded snapshot if
// listener-delivered progress (or a clear) landed while the invoke was in flight.
const operationVersions = new Map<string, number>();

function getOperationVersion(providerId: string): number {
  return operationVersions.get(providerId) ?? 0;
}

function bumpOperationVersion(providerId: string) {
  operationVersions.set(providerId, getOperationVersion(providerId) + 1);
}

export const useModelSetupStore = create<ModelSetupStore>((set, get) => ({
  operations: new Map(),

  init: async () => {
    if (initialized) return;
    initialized = true;

    // Attach the listener *before* the snapshot read so a transition landing
    // between the two isn't missed. The rehydration merge below preserves any
    // listener snapshot that arrives while the list request is in flight.
    await onModelSetupState((providerId, operation) => {
      get().setOperation(providerId, operation);
    });

    try {
      const entries = await listModelSetupStatus();
      set((state) => {
        const operations = new Map(state.operations);
        for (const [providerId, operation] of entries) {
          if (!operations.has(providerId)) {
            operations.set(providerId, operation);
            bumpOperationVersion(providerId);
          }
        }
        return { operations };
      });
    } catch (error) {
      console.error("Failed to rehydrate model setup status:", error);
    }
  },

  startSetup: async (providerId, plan) => {
    // Reflect the backend's seeded snapshot immediately so the spinner shows
    // when no listener event beats the command response back to the store.
    const startVersion = getOperationVersion(providerId);
    const operation = await startModelSetup(providerId, plan);
    if (getOperationVersion(providerId) !== startVersion) return;
    get().setOperation(providerId, operation);
  },

  getStatus: (providerId) => get().operations.get(providerId),

  setOperation: (providerId, operation) => {
    bumpOperationVersion(providerId);
    set((state) => {
      const operations = new Map(state.operations);
      operations.set(providerId, operation);
      return { operations };
    });
  },

  clear: (providerId) => {
    bumpOperationVersion(providerId);
    void clearModelSetupStatus(providerId).catch((error) => {
      console.error("Failed to clear model setup status:", error);
    });
    set((state) => {
      if (!state.operations.has(providerId)) return state;
      const operations = new Map(state.operations);
      operations.delete(providerId);
      return { operations };
    });
  },
}));
