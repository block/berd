import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Renderer (WKWebView WebContent) memory telemetry bridge.
 *
 * The Rust `renderer_monitor` service samples the WebContent process RSS and
 * emits `goose:renderer-stats`; it also logs silent OOM reaps. This module is
 * the frontend counterpart: it lets the UI observe those samples and forward
 * its own lifecycle signals (e.g. an unexpected reload) into `goose.log`.
 */
export const RENDERER_STATS_EVENT = "goose:renderer-stats";

export interface RendererStatsPayload {
  pid: number;
  rssBytes: number;
  rssMb: number;
}

export type RendererLogLevel = "info" | "warn" | "error";

/** Forward a renderer lifecycle event to the backend app log. */
export async function logRendererEvent(
  level: RendererLogLevel,
  message: string,
): Promise<void> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    return;
  }
  try {
    await invoke("log_renderer_event", { level, message });
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
