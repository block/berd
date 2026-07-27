import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_STATE,
  resolveFloatingTerminalRect,
  resolveFloatingTerminalResizeRect,
  resolveTerminalDockedPlacement,
  validateTerminalState,
} from "./terminalState";

describe("terminal state", () => {
  it("clamps floating rects into the viewport", () => {
    const rect = resolveFloatingTerminalRect({
      x: -100,
      y: -100,
      width: 10_000,
      height: 10_000,
    });

    expect(rect.x).toBeGreaterThanOrEqual(16);
    expect(rect.y).toBeGreaterThanOrEqual(16);
    expect(rect.width).toBeGreaterThanOrEqual(280);
    expect(rect.height).toBeGreaterThanOrEqual(220);
    expect(rect.x + rect.width).toBeLessThanOrEqual(window.innerWidth - 16);
    expect(rect.y + rect.height).toBeLessThanOrEqual(window.innerHeight - 16);
  });

  it("lets a dragging rect overhang the viewport while keeping a grabbable strip", () => {
    const dragged = resolveFloatingTerminalRect(
      { x: -200, y: 50, width: 500, height: 300 },
      "drag",
    );

    // It may overhang the left edge (its left can be negative)...
    expect(dragged.x).toBeLessThan(16);
    // ...but a grabbable strip must remain reachable on the right side.
    expect(dragged.x + dragged.width).toBeGreaterThan(16);

    // Settle mode (the default) pins the same rect fully inside the margin box.
    const settled = resolveFloatingTerminalRect({
      x: -200,
      y: 50,
      width: 500,
      height: 300,
    });
    expect(settled.x).toBeGreaterThanOrEqual(16);
  });

  it("resizes floating rects from an edge while preserving min size", () => {
    const resized = resolveFloatingTerminalResizeRect(
      { x: 100, y: 100, width: 500, height: 300 },
      "bottom-right",
      40,
      50,
    );

    expect(resized).toEqual({ x: 100, y: 100, width: 540, height: 350 });

    const clamped = resolveFloatingTerminalResizeRect(
      { x: 100, y: 100, width: 500, height: 300 },
      "top-left",
      1_000,
      1_000,
    );

    expect(clamped.width).toBe(280);
    expect(clamped.height).toBe(220);
  });

  it("drops connection-scoped agent tabs when restoring persisted state", () => {
    const restored = validateTerminalState(
      {
        tabs: [
          { id: "user-terminal", cwd: "/repo", source: "user" },
          {
            id: "agent-terminal",
            cwd: "/repo",
            source: "agent",
            title: "pnpm dev",
          },
        ],
        activeTabId: "agent-terminal",
        expanded: true,
      },
      DEFAULT_TERMINAL_STATE,
    );

    expect(restored.tabs).toEqual([
      { id: "user-terminal", cwd: "/repo", source: "user" },
    ]);
    expect(restored.activeTabId).toBe("user-terminal");
    expect(restored.expanded).toBe(true);
  });

  it("only allows user-owned terminal tabs to restart", async () => {
    const { canRestartTerminalTab } = await import("./terminalState");

    expect(canRestartTerminalTab(null)).toBe(false);
    expect(canRestartTerminalTab({ id: "user-terminal", cwd: "/repo" })).toBe(
      true,
    );
    expect(
      canRestartTerminalTab({
        id: "agent-terminal",
        cwd: "/repo",
        source: "agent",
      }),
    ).toBe(false);
  });

  it("does not treat an agent process as the default workspace shell", async () => {
    const { findDefaultTerminalTab } = await import("./terminalState");
    expect(
      findDefaultTerminalTab(
        [
          {
            id: "agent-terminal",
            cwd: "/repo",
            source: "agent",
            title: "pnpm dev",
          },
          { id: "user-terminal", cwd: "/repo", source: "user" },
        ],
        "/repo",
      )?.id,
    ).toBe("user-terminal");
  });

  it("preserves right rail dock placement and height", () => {
    expect(
      resolveTerminalDockedPlacement({
        kind: "docked",
        region: "rightRail",
        slot: "belowContext",
        size: { height: 340 },
      }),
    ).toEqual({
      kind: "docked",
      region: "rightRail",
      slot: "belowContext",
      size: { height: 340 },
    });
  });

  it("migrates legacy floatingBounds and resets placement when no tabs remain", () => {
    expect(
      validateTerminalState(
        {
          tabs: [{ id: "tab-1", cwd: "/repo" }],
          activeTabId: "tab-1",
          expanded: true,
          placement: "floating",
          floatingBounds: {
            left: 10_000,
            top: 10_000,
            width: 100,
            height: 100,
          },
        },
        DEFAULT_TERMINAL_STATE,
      ),
    ).toMatchObject({
      activeTabId: "tab-1",
      expanded: true,
      placement: {
        kind: "floating",
        rect: {
          width: 280,
          height: 220,
        },
      },
    });

    expect(
      validateTerminalState(
        {
          tabs: [],
          activeTabId: null,
          expanded: true,
          placement: {
            kind: "floating",
            rect: { x: 10, y: 10, width: 500, height: 300 },
          },
        },
        DEFAULT_TERMINAL_STATE,
      ),
    ).toMatchObject({
      expanded: false,
      placement: { kind: "docked" },
    });
  });
});
