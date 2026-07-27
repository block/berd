import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Rust broker → renderer command event (emitted to the main window only). */
const BERDCTL_REQUEST_EVENT = "berdctl:request";

/** Payload of an {@link BERDCTL_REQUEST_EVENT} event. */
export interface BridgeRequest {
  /** Correlates the response submitted via submit_result. */
  id: string;
  /** Command group name, e.g. "sessions". */
  command: string;
  /** Raw JSON args; validated in the renderer by zod. */
  args: unknown;
  /** The broker-resolved effective timeout for this call (ms). The renderer
   *  derives its deadline from this so a request `timeout_ms` override cannot
   *  skew the two sides' deadlines apart. */
  timeoutMs: number;
}

/** Renderer → Rust response, submitted via plugin:berdctl|submit_result. */
export interface BridgeResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface BerdctlEndpoint {
  port: number;
}

/** Starts the broker server (idempotent) and returns its loopback port. */
export async function startBerdctlServer(): Promise<BerdctlEndpoint> {
  return invoke<BerdctlEndpoint>("plugin:berdctl|start");
}

/** Stops the broker server. */
export async function stopBerdctlServer(): Promise<void> {
  await invoke("plugin:berdctl|stop");
}

interface BrokerStatus {
  running: boolean;
}

/**
 * Read-only broker liveness from the plugin — the single source of truth
 * for "an agent can reach the app through `berdctl` right now". Works from
 * any window: the broker lifecycle runs in the main window, but popped-out
 * session windows also send prompts and must not keep a renderer-local copy
 * of an app-global fact.
 */
export async function getBerdctlBrokerStatus(): Promise<BrokerStatus> {
  return invoke<BrokerStatus>("plugin:berdctl|status");
}

/** Pushes the per-command timeout map (ms); the broker clamps each value to
 *  its MAX_COMMAND_TIMEOUT and uses its default for commands not listed. */
export async function setBerdctlTimeouts(
  timeouts: Record<string, number>,
): Promise<void> {
  await invoke("plugin:berdctl|set_timeouts", { timeouts });
}

/** Submits a command result back to the broker (duplicate-tolerant). */
export async function submitBerdctlResult(result: BridgeResult): Promise<void> {
  await invoke("plugin:berdctl|submit_result", { result });
}

/**
 * Listens for broker command requests. Mirrors
 * `listenLocalMediaCachesCleared` (src/shared/api/localMediaCaches.ts): a
 * no-op unlistener outside the Tauri webview.
 */
export function listenBerdctlRequests(
  handler: (request: BridgeRequest) => void,
): Promise<UnlistenFn> {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<BridgeRequest>(BERDCTL_REQUEST_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * True when an invoke rejection means the berdctl plugin is not in this
 * build (Cargo feature off) or not granted to this window. Covers both Tauri
 * shapes: ACL denial ("berdctl.start not allowed. Permissions associated
 * with this command: …") and unknown command ("Command berdctl|start not
 * found").
 */
export function isPluginUnavailableError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  const normalized = message.toLowerCase();
  if (!normalized.includes("berdctl")) {
    return false;
  }
  return normalized.includes("not allowed") || normalized.includes("not found");
}
