import { create } from "zustand";

import {
  clearAgentSetupStatus,
  listAgentSetupStatus,
  onAgentSetupState,
  startAgentSetup,
  type AgentSetupAction,
  type AgentSetupOperation,
  type AgentSetupPlan,
} from "@/features/providers/api/agentSetup";

// Thin, backend-backed view of agent setup progress. Unlike
// `providerModelCacheStore` this is *not* the source of truth and is never
// persisted to localStorage — the Rust registry owns the truth. The store just
// mirrors the latest `agent-setup:state` snapshot per provider so cards can be
// pure views that rehydrate instantly on (re)mount and survive a full reload.

interface AgentSetupState {
  operations: Map<string, AgentSetupOperation>;
}

interface AgentSetupActions {
  // App-level, idempotent: attach the `agent-setup:state` listener and
  // rehydrate from `list_agent_setup_status()`. Run once at startup (before any
  // card mounts) so reload survival works.
  init: () => Promise<void>;
  startSetup: (
    providerId: string,
    action: AgentSetupAction,
    plan: AgentSetupPlan,
  ) => Promise<void>;
  getStatus: (providerId: string) => AgentSetupOperation | undefined;
  // Replace a provider's snapshot. Used by the event listener, the startup
  // rehydration, and (in dev) the failure-simulation hook.
  setOperation: (providerId: string, operation: AgentSetupOperation) => void;
  // Drop a terminal entry the card has consumed (clears the backend registry
  // too so the GC backstop has less to sweep).
  clear: (providerId: string) => void;
}

export type AgentSetupStore = AgentSetupState & AgentSetupActions;

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

export const useAgentSetupStore = create<AgentSetupStore>((set, get) => ({
  operations: new Map(),

  init: async () => {
    if (initialized) return;
    initialized = true;

    // Attach the listener *before* the snapshot read so a transition landing
    // between the two isn't missed. The rehydration merge below preserves any
    // listener snapshot that arrives while the list request is in flight.
    await onAgentSetupState((providerId, operation) => {
      get().setOperation(providerId, operation);
    });

    try {
      const entries = await listAgentSetupStatus();
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
      console.error("Failed to rehydrate agent setup status:", error);
    }
  },

  startSetup: async (providerId, action, plan) => {
    // Reflect the backend's seeded snapshot immediately so the spinner shows
    // when no listener event beats the command response back to the store.
    const startVersion = getOperationVersion(providerId);
    const operation = await startAgentSetup(providerId, action, plan);
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
    void clearAgentSetupStatus(providerId).catch((error) => {
      console.error("Failed to clear agent setup status:", error);
    });
    set((state) => {
      if (!state.operations.has(providerId)) return state;
      const operations = new Map(state.operations);
      operations.delete(providerId);
      return { operations };
    });
  },
}));
