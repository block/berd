import type { AppCommand } from "./types";

/**
 * Per-action bridge timeout (ms) shared by the set_timeouts push (lifecycle.ts
 * sends the broker each action's timeout at start) and dispatch's deadline
 * fallback for direct callers. The values are the authoritative half
 * of the renderer/broker timeout contract:
 *
 * - sessions.create declares 900s because startup worktree creation may take
 *   up to 15 minutes; send/fork declare 60s for backend work.
 * - sessions.archive declares 150s for Git inspection and cleanup.
 * - Everything else is a fast local operation.
 *
 * The broker's MAX_COMMAND_TIMEOUT (900s) matches the largest value here, and
 * the berdctl CLI's HTTP timeout (910s) is above the broker max so the broker
 * always gives up first with a clean error.
 */
export function commandBridgeTimeoutMs(
  command: Pick<AppCommand<unknown, unknown>, "bridgeTimeoutMs">,
): number {
  return command.bridgeTimeoutMs ?? 30_000;
}
