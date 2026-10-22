// Production WindowPort/PositionStore implementations. Thin by design:
// all decision logic lives in panelState.ts (tested), all coordinate
// flips live in Rust's desktop_agent::coordinate_space (sole authority).

import { invoke } from "@tauri-apps/api/core";

import type { Rect, ScreenInfo } from "./anchorGeometry";
import type { PositionStore, WindowPort } from "./panelState";

interface RectDto {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenDto {
  frame: RectDto;
  visibleFrame: RectDto;
  isMain: boolean;
}

export class TauriWindowPort implements WindowPort {
  async getScreens(): Promise<ScreenInfo[]> {
    const screens = await invoke<ScreenDto[]>("desktop_agent_get_screens");
    return screens.map((s) => ({
      frame: s.frame,
      visibleFrame: s.visibleFrame,
      isMain: s.isMain,
    }));
  }

  async getPanelFrame(): Promise<Rect> {
    return invoke<RectDto>("desktop_agent_get_panel_frame");
  }

  async setState(args: { expanded: boolean; frame: Rect }): Promise<void> {
    await invoke("desktop_agent_set_state", {
      expanded: args.expanded,
      frame: args.frame,
    });
  }

  async startDrag(): Promise<void> {
    await invoke("desktop_agent_start_drag");
  }
}

/** Panel position persistence in webview localStorage (fresh state — the
 *  panel owns it; the window-state plugin denylists this window). */
export const PANEL_POSITION_STORAGE_KEY = "goose:desktop-agent:panel-position";

export class LocalStoragePositionStore implements PositionStore {
  async load(): Promise<{ x: number; y: number } | null> {
    try {
      const raw = localStorage.getItem(PANEL_POSITION_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { x?: unknown }).x === "number" &&
        typeof (parsed as { y?: unknown }).y === "number"
      ) {
        return {
          x: (parsed as { x: number }).x,
          y: (parsed as { y: number }).y,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async save(position: { x: number; y: number }): Promise<void> {
    try {
      localStorage.setItem(
        PANEL_POSITION_STORAGE_KEY,
        JSON.stringify(position),
      );
    } catch {
      // Persistence is best-effort; the panel still works this session.
    }
  }
}
