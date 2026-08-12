import {
  isPluginUnavailableError,
  setBerdctlTimeouts,
  startBerdctlServer,
  stopBerdctlServer,
  submitBerdctlResult,
  type BridgeRequest,
  type BridgeResult,
} from "@/features/berdctl/bridge/berdctlPlugin";
import {
  dispatchCommand,
  TOOL_GROUPS,
} from "@/features/berdctl/commands/registry";
import { commandBridgeTimeoutMs } from "@/features/berdctl/commands/timeouts";
import { toCommandError } from "@/features/berdctl/commands/types";

/**
 * Module-scoped lifecycle singleton for the berdctl broker.
 *
 * There is exactly one broker and one main window, so the state lives here —
 * not in component state — which also makes the lifecycle safe under React
 * StrictMode double-mounts: effects only declare the *desired* state
 * (enabled/disabled) and a single serialized reconciler converges on it. A
 * StrictMode mount→cleanup→mount sequence flips desired true→false→true
 * synchronously before the reconciler runs, so the broker the second mount
 * needs is never torn down by the first mount's cleanup.
 */
interface LifecycleState {
  /** True while the broker is running (start + set_timeouts succeeded). */
  running: boolean;
  /** Set on an invoke rejection that means the Cargo feature is off; the
   *  bridge goes inert (no retries, no further invokes) until the next
   *  enable attempt clears the flag. */
  pluginUnavailable: boolean;
}

function freshState(): LifecycleState {
  return {
    running: false,
    pluginUnavailable: false,
  };
}

let state = freshState();
let desired = false;
let applied = false;
let reconcilePromise: Promise<void> | null = null;

/**
 * Declares whether the broker should be running. Idempotent; the reconciler
 * serializes start/stop and converges on the latest declared value.
 */
export function setBerdctlDesired(next: boolean): void {
  if (next) {
    // Each enable attempt retries a previously-unavailable plugin once;
    // retry-storms stay impossible because the reconciler only runs on
    // toggles.
    state.pluginUnavailable = false;
  }
  desired = next;
  void reconcile();
}

function reconcile(): Promise<void> {
  if (!reconcilePromise) {
    reconcilePromise = (async () => {
      try {
        // Suspend once so the `reconcilePromise =` assignment completes
        // before the finally below can run. Without this, a loop body that
        // finishes synchronously would null the *previous* value and leave a
        // stale settled promise wedged in `reconcilePromise` forever.
        await Promise.resolve();
        // Converge `applied` on `desired`. A failed start still marks the
        // desired value as applied so a broken broker does not retry-storm;
        // toggling the experiment off/on retries explicitly.
        while (applied !== desired) {
          const want = desired;
          if (want) {
            await doStart();
          } else {
            await doStop();
          }
          applied = want;
        }
      } finally {
        reconcilePromise = null;
      }
    })();
  }
  return reconcilePromise;
}

/** Per-action bridge timeout map keyed by `<group>.<action>`. */
function actionTimeoutsMs(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(TOOL_GROUPS).flatMap(([group, { actions }]) =>
      Object.entries(actions).map(([action, command]) => [
        `${group}.${action}`,
        commandBridgeTimeoutMs(command),
      ]),
    ),
  );
}

async function doStart(): Promise<void> {
  if (state.pluginUnavailable || state.running) {
    return;
  }
  let started = false;
  try {
    await startBerdctlServer();
    started = true;
    await setBerdctlTimeouts(actionTimeoutsMs());
    state.running = true;
  } catch (error) {
    if (started) {
      try {
        await stopBerdctlServer();
      } catch (stopError) {
        console.error(
          "[berdctl] failed to stop broker after startup failure",
          stopError,
        );
      }
    }
    if (isPluginUnavailableError(error)) {
      state.pluginUnavailable = true;
      console.warn(
        "[berdctl] plugin unavailable in this build; bridge is inert",
      );
    } else {
      console.error("[berdctl] failed to start broker", error);
    }
  }
}

async function doStop(): Promise<void> {
  if (state.pluginUnavailable || !state.running) {
    return;
  }
  state.running = false;
  try {
    await stopBerdctlServer();
  } catch (error) {
    console.error("[berdctl] failed to stop broker", error);
  }
}

/**
 * Handles one broker request. Never rejects: command failures are reported
 * via submit_result, and submit failures are logged and dropped (the broker
 * times the request out).
 */
export async function handleBerdctlRequest(
  request: BridgeRequest,
): Promise<void> {
  let result: BridgeResult;
  try {
    // The broker resolved this call's effective timeout (including any
    // request override); deriving the deadline from it keeps both sides'
    // deadlines aligned.
    const ctx = { deadlineMs: Date.now() + request.timeoutMs };
    const data = await dispatchCommand(request.command, request.args, ctx);
    result = { id: request.id, ok: true, data };
  } catch (error) {
    result = { id: request.id, ok: false, error: toCommandError(error) };
  }
  try {
    await submitBerdctlResult(result);
  } catch (error) {
    console.error("[berdctl] failed to submit bridge result", error);
  }
}

/** Test-only: drop all lifecycle state without invoking the plugin. */
export function __resetBerdctlLifecycleForTests(): void {
  state = freshState();
  desired = false;
  applied = false;
  reconcilePromise = null;
}
