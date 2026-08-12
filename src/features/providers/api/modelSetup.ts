import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// The backend (`src-tauri/src/commands/model_setup.rs`) is the source of truth
// for a model provider's native sign-in progress. The frontend only kicks an
// operation off (`startModelSetup`), observes it (`onModelSetupState` +
// `listModelSetupStatus` rehydration), and clears the terminal entry it
// consumes (`clearModelSetupStatus`). This is what lets the sign-in's spinner /
// streamed output / result survive navigation *and* a full window reload.

export type ModelSetupPhase = "idle" | "authenticating";

export type ModelSetupStatus = "running" | "succeeded" | "failed";

// One provider's in-flight (or just-finished) native sign-in. Mirrors the Rust
// `ModelSetupOperation` (camelCase serde); `updatedAtMs` is backend-only GC
// bookkeeping the UI ignores.
export interface ModelSetupOperation {
  phase: ModelSetupPhase;
  status: ModelSetupStatus;
  output: string[];
  error: string | null;
}

// The execution recipe captured at click time. The row already knows the
// provider's native-connect label, so the backend never has to re-derive it
// while still running the `goose configure` flow autonomously (survives reload).
export interface ModelSetupPlan {
  // The provider's `nativeConnectQuery` (e.g. `databricks`).
  providerLabel: string;
}

interface ModelSetupStateEvent {
  providerId: string;
  operation: ModelSetupOperation;
}

// Kick off (idempotently) a provider's native sign-in. Returns the seeded
// snapshot; if one is already running for this provider the backend no-ops and
// returns the live snapshot.
export async function startModelSetup(
  providerId: string,
  plan: ModelSetupPlan,
): Promise<ModelSetupOperation> {
  return invoke("start_model_setup", { providerId, plan });
}

export async function getModelSetupStatus(
  providerId: string,
): Promise<ModelSetupOperation | null> {
  return invoke("get_model_setup_status", { providerId });
}

// One call rehydrates every row on mount — cheaper than N `get`s when the
// providers screen mounts many rows.
export async function listModelSetupStatus(): Promise<
  [string, ModelSetupOperation][]
> {
  return invoke("list_model_setup_status");
}

export async function clearModelSetupStatus(providerId: string): Promise<void> {
  return invoke("clear_model_setup_status", { providerId });
}

// Subscribe to the single per-change snapshot event. Each event carries the
// full bounded operation, so the store replaces its view wholesale (no
// incremental merge to get wrong).
export function onModelSetupState(
  callback: (providerId: string, operation: ModelSetupOperation) => void,
): Promise<UnlistenFn> {
  return listen<ModelSetupStateEvent>("model-setup:state", (event) => {
    callback(event.payload.providerId, event.payload.operation);
  });
}
