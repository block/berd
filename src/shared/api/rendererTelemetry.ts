import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Renderer (WKWebView WebContent) memory telemetry bridge.
 *
 * The Rust `renderer_monitor` service samples the WebContent process RSS and
 * emits `berd:renderer-stats`; it also logs silent OOM reaps. This module is
 * the frontend counterpart: it lets the UI observe those samples and forward
 * its own lifecycle signals (e.g. an unexpected reload) into `goose.log`.
 */
export const RENDERER_STATS_EVENT = "berd:renderer-stats";

export interface RendererStatsPayload {
  pid: number;
  rssBytes: number;
  rssMb: number;
}

export type RendererLogLevel = "info" | "warn" | "error";

/**
 * Log target for dev-time telemetry-viewer lines. The Rust side validates to
 * this closed set (anything else falls back to its default target) and its
 * Stdout formatter renders these records grey in the `just dev` terminal;
 * the file target prints them uncolored.
 */
export type RendererLogTarget = "telemetry";

/** Forward a renderer lifecycle event to the backend app log. */
export async function logRendererEvent(
  level: RendererLogLevel,
  message: string,
  target?: RendererLogTarget,
): Promise<void> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    return;
  }
  try {
    await invoke("log_renderer_event", { level, message, target });
  } catch {
    // Logging is best-effort; never let it break the UI.
  }
}

/** Subscribe to renderer memory samples emitted by the backend monitor. */
export function listenRendererStats(
  handler: (payload: RendererStatsPayload) => void,
) {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<RendererStatsPayload>(RENDERER_STATS_EVENT, (event) =>
    handler(event.payload),
  );
}
