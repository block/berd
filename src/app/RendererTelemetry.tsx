import { useEffect } from "react";
import {
  listenRendererStats,
  logRendererEvent,
  type RendererStatsPayload,
} from "@/shared/api/rendererTelemetry";
import { perfLog } from "@/shared/lib/perfLog";

const LAST_BOOT_KEY = "goose.renderer.lastBootAt";

/**
 * If two production boots happen within this window the renderer likely
 * reloaded on its own (for example, a WebKit OOM reap) rather than the user
 * restarting. Dev reloads are expected during Vite/Tauri workflows.
 */
const RAPID_RELOAD_MS = 60_000;

declare global {
  interface Window {
    __gooseRendererStats?: RendererStatsPayload;
  }
}

// Module-scoped so React StrictMode's double-mount in dev doesn't double-log.
let bootReported = false;

function reportBoot(): void {
  if (bootReported) {
    return;
  }
  bootReported = true;

  let previousBootAt: number | null = null;
  try {
    const raw = localStorage.getItem(LAST_BOOT_KEY);
    previousBootAt = raw ? Number.parseInt(raw, 10) : null;
    localStorage.setItem(LAST_BOOT_KEY, String(Date.now()));
  } catch {
    // localStorage may be unavailable; still report the boot below.
  }

  if (previousBootAt && Number.isFinite(previousBootAt)) {
    const elapsedMs = Date.now() - previousBootAt;
    const elapsedSec = Math.round(elapsedMs / 1000);
    if (elapsedMs >= 0 && elapsedMs < RAPID_RELOAD_MS) {
      const event = buildRapidReloadEvent(
        elapsedSec,
        import.meta.env.DEV && import.meta.env.MODE !== "test",
      );
      void logRendererEvent(event.level, event.message);
    } else {
      void logRendererEvent(
        "info",
        `renderer booted (previous load ${elapsedSec}s ago)`,
      );
    }
  } else {
    void logRendererEvent("info", "renderer booted (first load this install)");
  }
}

function buildRapidReloadEvent(
  elapsedSec: number,
  isDev: boolean,
): { level: "info" | "warn"; message: string } {
  if (isDev) {
    return {
      level: "info",
      message: `renderer reloaded ${elapsedSec}s after the previous load during dev`,
    };
  }

  return {
    level: "warn",
    message: `renderer reloaded ${elapsedSec}s after the previous load; likely an unexpected reload (possible OOM reap)`,
  };
}

/**
 * Headless component that wires the renderer to the backend telemetry:
 * reports each (re)boot to `goose.log` and mirrors memory samples to the
 * console / `window.__gooseRendererStats` for debugging.
 */
export function RendererTelemetry() {
  useEffect(() => {
    reportBoot();

    const unlisten = listenRendererStats((payload) => {
      window.__gooseRendererStats = payload;
      perfLog(
        `[perf:renderer] WebContent rss=${payload.rssMb} MB (pid ${payload.pid})`,
      );
    });

    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, []);

  return null;
}
