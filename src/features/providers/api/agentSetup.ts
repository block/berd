import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { FixType } from "@/shared/api/doctor";

// The backend (`src-tauri/src/commands/agent_setup.rs`) is the source of truth
// for an agent provider's install / update / auth progress. The frontend only
// kicks an operation off (`startAgentSetup`), observes it (`onAgentSetupState`
// + `listAgentSetupStatus` rehydration), and clears the terminal entry it
// consumes (`clearAgentSetupStatus`). This is what lets progress survive
// navigation *and* a full window reload.

export type AgentSetupAction = "install" | "update" | "auth";

export type AgentSetupPhase =
  | "idle"
  | "checking"
  | "installing"
  | "authenticating"
  // Downloading/installing the Berd-managed Node.js runtime an npm-backed
  // fix is about to run on.
  | "preparingRuntime";

export type AgentSetupStatus = "running" | "succeeded" | "failed";

// One provider's in-flight (or just-finished) setup operation. Mirrors the
// Rust `SetupOperation` (camelCase serde); `updatedAtMs` is backend-only GC
// bookkeeping the UI ignores.
export interface AgentSetupOperation {
  action: AgentSetupAction;
  phase: AgentSetupPhase;
  status: AgentSetupStatus;
  output: string[];
  error: string | null;
}

export type AgentSetupUpdateFixType = Extract<
  FixType,
  "updateMain" | "updateBridge"
>;

// The execution recipe captured at click time. The card derives this from the
// doctor report's actionable readouts, so the backend never has to re-derive
// them while still running the chain autonomously (survives reload).
export interface AgentSetupPlan {
  // The install recipe to seed the install loop with, or null for a pure
  // update / auth.
  installFixType: Extract<FixType, "command" | "bridge"> | null;
  // Which per-readout updates to run after the install loop (`updateMain` /
  // `updateBridge`). The card names only the readout slot; the backend resolves
  // the exact source-aware command from the crate's trusted freshness readout,
  // so no renderer-supplied shell command crosses the wire.
  updateFixTypes: AgentSetupUpdateFixType[];
  // Whether the backend probes PATH after the fix to confirm the agent landed.
  // `hasBinary && !isBuiltIn`: a built-in or binary-less provider has nothing to
  // resolve on disk, so the backend skips verification and takes a clean run as
  // success (the readiness derivation that drives this stays here in the card).
  verifyInstall: boolean;
  // Whether Berd bundles this provider's ACP bridge. The bridge vendors the
  // full harness CLI, so it is the provider's only binary and reports under
  // `path`; post-fix verification then requires `path` to have resolved,
  // matching the readiness gate in `readinessFromReport` — a broken bundle
  // must fail verification instead of reporting a success the card
  // immediately contradicts as not_installed.
  bundledBridge?: boolean;
}

interface AgentSetupStateEvent {
  providerId: string;
  operation: AgentSetupOperation;
}

// Kick off (idempotently) a provider's setup operation. Returns the seeded
// snapshot; if one is already running for this provider the backend no-ops and
// returns the live snapshot.
export async function startAgentSetup(
  providerId: string,
  action: AgentSetupAction,
  plan: AgentSetupPlan,
): Promise<AgentSetupOperation> {
  return invoke("start_agent_setup", { providerId, action, plan });
}

export async function getAgentSetupStatus(
  providerId: string,
): Promise<AgentSetupOperation | null> {
  return invoke("get_agent_setup_status", { providerId });
}

// One call rehydrates every card on mount — cheaper than N `get`s when the
// providers screen mounts many cards.
export async function listAgentSetupStatus(): Promise<
  [string, AgentSetupOperation][]
> {
  return invoke("list_agent_setup_status");
}

export async function clearAgentSetupStatus(providerId: string): Promise<void> {
  return invoke("clear_agent_setup_status", { providerId });
}

// Subscribe to the single per-change snapshot event. Each event carries the
// full bounded operation, so the store replaces its view wholesale (no
// incremental merge to get wrong).
export function onAgentSetupState(
  callback: (providerId: string, operation: AgentSetupOperation) => void,
): Promise<UnlistenFn> {
  return listen<AgentSetupStateEvent>("agent-setup:state", (event) => {
    callback(event.payload.providerId, event.payload.operation);
  });
}
