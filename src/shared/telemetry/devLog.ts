/**
 * Dev-time telemetry event viewer.
 *
 * Prints every event that fires to the terminal running `just dev`, so a
 * developer can watch the catalog live. This is a tap, not a transport: it
 * hangs off the top of `trackEvent` — the single chokepoint every event funnels
 * through — so it reports what *fired*, independent of what the build gate, the
 * consent gate, or the startup buffer does with the event next. A tap further
 * down (the exporter, the native command) would show nothing at all in dev,
 * where the build gate closes before any of that is even constructed.
 *
 * The forward rides the existing renderer log bridge — `logRendererEvent` → the
 * `log_renderer_event` command → `log::info!` → `tauri-plugin-log`'s Stdout
 * target — which is the one surface every window shares. The main window and
 * each detached `session:*` window are separate webviews with separate devtools
 * consoles, and all of them fire events; they converge only in the single Rust
 * process, which is why the terminal beats a console. The log line lands in
 * dev's `berd.log` for free.
 *
 * The forward is tagged with the `"telemetry"` log target rather than a
 * message prefix: the default log format prints it as `[telemetry]` in both
 * the terminal and `berd.log`, and the Rust Stdout formatter keys off it to
 * render these lines grey so they read apart from ordinary log output. The
 * message itself must stay free of ANSI escapes — the same message reaches the
 * file target, where color codes would be pollution; styling belongs to the
 * Stdout formatter alone.
 *
 * Gated on `import.meta.env.DEV`, deliberately not `getEnvironment()`: the
 * latter defaults *any* build without `VITE_ENVIRONMENT` to "development",
 * generic packaged builds included, which would write event payloads — they
 * carry chat session ids and provider/model usage — into a user's `berd.log`
 * without consent.
 * `import.meta.env.DEV` is true only under the Vite dev server and is
 * statically replaced with `false` in every `vite build` output, so the tap is
 * eliminated as dead code outside dev and cannot become a consent bypass. Even
 * in dev it only ever reaches the local log, never the exporter.
 *
 * The complementary `VITE_TELEMETRY_DEBUG` / `berd.telemetry.debug` console
 * hook in `./client` is unchanged; it stays the per-window, object-level view.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

import { logRendererEvent } from "@/shared/api/rendererTelemetry";
import type { Event } from "@/shared/telemetry/events";

// Memoized: the label is fixed for the lifetime of the webview, and every
// window in the app writes into the same terminal, so it is what tells a `main`
// fire apart from a `session:<id>` one. Resolved through the window API rather
// than the webview one because that is what the rest of the app uses; for
// Berd's windows (one webview each) the two report the same label.
let cachedWindowLabel: string | null = null;

function currentWindowLabel(): string {
  if (cachedWindowLabel === null) {
    try {
      cachedWindowLabel = getCurrentWindow().label;
    } catch {
      // No Tauri internals (tests, a browser preview): the forward below is a
      // no-op anyway, so a placeholder keeps formatting total.
      cachedWindowLabel = "unknown";
    }
  }
  return cachedWindowLabel;
}

/**
 * Logs one fired event to the `just dev` terminal. No-op outside the Vite dev
 * server.
 *
 * The event's params are exactly the attributes the record would carry — with
 * one caveat worth knowing: they are logged *pre-truncation*. The OTel
 * `attributeValueLengthLimit` applies at the `LoggerProvider`, which does not
 * exist in dev, so a long value prints in full here and would be cut on the
 * wire. Read the line as "what fired", not as the exact wire payload.
 */
export function devLogEvent(createEvent: () => Event): void {
  if (!import.meta.env.DEV) return;

  try {
    const event = createEvent();
    const line = `${currentWindowLabel()} ${event.name} ${JSON.stringify(
      event.parameters,
    )}`;
    // Fire-and-forget. `logRendererEvent` already swallows invoke failures and
    // no-ops without Tauri internals; the catch keeps a future change there
    // from turning a diagnostic into an unhandled rejection in `track()`.
    void logRendererEvent("info", line, "telemetry").catch(() => {
      // A diagnostic must never affect app behavior.
    });
  } catch {
    // Same: a throwing event thunk is the caller's problem to surface, not
    // something the viewer should escalate.
  }
}
