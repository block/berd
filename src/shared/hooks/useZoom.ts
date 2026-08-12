import { useEffect } from "react";

import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";

const KEY = "goose-zoom-level";
const STEP = 0.1;
const MIN = 0.7;
const MAX = 1.3;

function adjust(n: number) {
  return Math.round(Math.min(MAX, Math.max(MIN, n)) * 100) / 100;
}

function getStored(): number {
  const v = Number.parseFloat(localStorage.getItem(KEY) ?? "");
  return Number.isNaN(v) ? 1.0 : adjust(v);
}

function applyZoom(level: number) {
  document.documentElement.style.setProperty(
    "--goose-content-zoom",
    String(level),
  );
}

export function useZoom() {
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;

    let level = getStored();
    applyZoom(level);

    const handler = (e: KeyboardEvent) => {
      if (eventMatchesShortcutCommand(e, "view.zoomIn")) {
        level = adjust(level + STEP);
      } else if (eventMatchesShortcutCommand(e, "view.zoomOut")) {
        level = adjust(level - STEP);
      } else if (eventMatchesShortcutCommand(e, "view.zoomReset")) {
        level = adjust(1.0);
      } else {
        return;
      }

      e.preventDefault();
      localStorage.setItem(KEY, String(level));
      applyZoom(level);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
