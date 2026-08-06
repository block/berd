import {
  getBerdctlBrokerStatus,
  isPluginUnavailableError,
} from "@/features/berdctl/bridge/berdctlPlugin";

/**
 * App context preamble injected into every agent session while the berdctl
 * broker is running. It exists to make berdctl discoverable: the CLI is on
 * the harness's PATH (goose_serve.rs sets the shim and BERDCTL_BIN), but
 * nothing else ever tells the model it exists.
 *
 * Kept deliberately small (~85 tokens): nouns and verbs only — enough for
 * the model to route a request like "create a new chat" to
 * `berdctl session create` — with all argument detail deferred to `--help`.
 * The noun/verb lines are pinned against cli-surface.json by
 * appPreamble.test.ts so renames cannot drift silently; the listing is
 * intentionally non-exhaustive (niche verbs are omitted to save tokens).
 */
export const BERDCTL_PREAMBLE = `[Berd]
You are running inside Berd, a desktop app for working with agents.
A CLI named \`berdctl\` is on your PATH; it controls the Berd app itself.

Usage: berdctl <noun> <verb> [--json]
- session: create, send, open, list, get, rename, fork, archive, move
- folder: attach, detach, replace, set-cwd, list
- project: create, list, get, archive
- agent: create, list
- skill: create, list, get
- info: context, harnesses, models

Run \`berdctl <noun> <verb> --help\` for arguments. When asked to switch or move this chat to a new worktree/folder, use \`folder replace\` on the current cwd attachment so the old folder is removed from context. Use \`folder set-cwd\` to select an already attached folder, or only when the old folder should remain additional context. Use \`folder attach\` only to add context without changing cwd; \`folder detach\` removes context without deleting files.`;

/** Set once an invoke rejection shows the plugin is not in this build or
 *  not granted; later sends skip the doomed IPC round-trip. */
let pluginUnavailable = false;

/**
 * The berdctl app preamble when an agent can actually reach the app, or
 * `null` when it cannot (plugin off, broker not running).
 *
 * Availability is asked of the plugin per send rather than cached in the
 * renderer: the broker lifecycle runs in the main window, but popped-out
 * session windows also send prompts, and a renderer-local flag would never
 * be set there (each window is its own renderer). The plugin owns the
 * broker, so it is the one source of truth every window can query.
 */
export async function getBerdctlPreamble(): Promise<string | null> {
  if (pluginUnavailable || !window.__TAURI_INTERNALS__) {
    return null;
  }
  try {
    const { running } = await getBerdctlBrokerStatus();
    return running ? BERDCTL_PREAMBLE : null;
  } catch (error) {
    if (isPluginUnavailableError(error)) {
      pluginUnavailable = true;
    } else {
      console.warn("[berdctl] failed to read broker status", error);
    }
    return null;
  }
}

/** Test-only: clear the cached plugin-unavailable state. */
export function __resetBerdctlPreambleForTests(): void {
  pluginUnavailable = false;
}
