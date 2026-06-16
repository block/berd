import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Rust broker → renderer command event (emitted to the main window only). */
const GOOSECTL_REQUEST_EVENT = "goosectl:request";

/** Payload of an {@link GOOSECTL_REQUEST_EVENT} event. */
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

/** Renderer → Rust response, submitted via plugin:goosectl|submit_result. */
export interface BridgeResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface GoosectlEndpoint {
  port: number;
}

/** Starts the broker server (idempotent) and returns its loopback port. */
export async function startGoosectlServer(): Promise<GoosectlEndpoint> {
  return invoke<GoosectlEndpoint>("plugin:goosectl|start");
}

/** Stops the broker server. */
export async function stopGoosectlServer(): Promise<void> {
  await invoke("plugin:goosectl|stop");
}

/** Pushes the per-command timeout map (ms); the broker clamps each value to
 *  its MAX_COMMAND_TIMEOUT and uses its default for commands not listed. */
export async function setGoosectlTimeouts(
  timeouts: Record<string, number>,
): Promise<void> {
  await invoke("plugin:goosectl|set_timeouts", { timeouts });
}

/** Submits a command result back to the broker (duplicate-tolerant). */
export async function submitGoosectlResult(
  result: BridgeResult,
): Promise<void> {
  await invoke("plugin:goosectl|submit_result", { result });
}

/**
 * Listens for broker command requests. Mirrors
 * `listenLocalMediaCachesCleared` (src/shared/api/localMediaCaches.ts): a
 * no-op unlistener outside the Tauri webview.
 */
export function listenGoosectlRequests(
  handler: (request: BridgeRequest) => void,
): Promise<UnlistenFn> {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<BridgeRequest>(GOOSECTL_REQUEST_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * True when an invoke rejection means the goosectl plugin is not in this
 * build (Cargo feature off) or not granted to this window. Covers both Tauri
 * shapes: ACL denial ("goosectl.start not allowed. Permissions associated
 * with this command: …") and unknown command ("Command goosectl|start not
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
  if (!normalized.includes("goosectl")) {
    return false;
  }
  return normalized.includes("not allowed") || normalized.includes("not found");
}
