// Ported from the prototype's test/shell/panel_state_test.dart — same cases against
// the same state-machine semantics, with the platform channel replaced by
// a fake WindowPort/PositionStore.

import { beforeEach, describe, expect, test } from "vitest";

import { rect, type Rect, type ScreenInfo } from "./anchorGeometry";
import {
  AVATAR_PANEL_SIZE,
  PanelStateMachine,
  type PositionStore,
  type WindowPort,
} from "./panelState";

const screens: ScreenInfo[] = [
  {
    frame: rect(0, 0, 1440, 900),
    visibleFrame: rect(0, 25, 1440, 815),
    isMain: true,
  },
];

class FakeWindow implements WindowPort {
  panelFrame: Rect = rect(700, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);
  calls: string[] = [];
  setStates: Array<{ expanded: boolean; frame: Rect }> = [];

  async getScreens(): Promise<ScreenInfo[]> {
    this.calls.push("getScreens");
    return screens;
  }

  async getPanelFrame(): Promise<Rect> {
    this.calls.push("getPanelFrame");
    return this.panelFrame;
  }

  async setState(args: { expanded: boolean; frame: Rect }): Promise<void> {
    this.calls.push("setState");
    this.setStates.push(args);
    this.panelFrame = args.frame;
  }

  async startDrag(): Promise<void> {
    this.calls.push("startDrag");
  }
}

class MemoryStore implements PositionStore {
  saved: { x: number; y: number } | null = null;

  async load(): Promise<{ x: number; y: number } | null> {
    return this.saved;
  }

  async save(position: { x: number; y: number }): Promise<void> {
    this.saved = position;
  }
}

let window_: FakeWindow;
let store: MemoryStore;
let machine: PanelStateMachine;

beforeEach(() => {
  window_ = new FakeWindow();
  store = new MemoryStore();
  machine = new PanelStateMachine({ window: window_, positionStore: store });
});

function lastSetState(window_: {
  setStates: Array<{ expanded: boolean; frame: Rect }>;
}): {
  expanded: boolean;
  frame: Rect;
} {
  const last = window_.setStates.at(-1);
  if (!last) throw new Error("expected at least one setState call");
  return last;
}

describe("PanelStateMachine", () => {
  test("syncFromPanel tracks current panel frame without persisting", async () => {
    window_.panelFrame = rect(320, 240, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);

    await machine.syncFromPanel();
    await machine.collapse();

    expect(window_.panelFrame).toEqual(
      rect(320, 240, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE),
    );
    expect(store.saved).toBeNull();
    expect(window_.calls).toEqual(["getPanelFrame", "setState"]);
  });

  test("restore uses saved position, clamped to the visible screen", async () => {
    store.saved = { x: 5000, y: -200 }; // way off-screen
    await machine.restore();

    const applied = lastSetState(window_);
    expect(applied.expanded).toBe(false);
    // Clamped fully inside the visible frame.
    expect(applied.frame.x).toBeLessThanOrEqual(1440 - AVATAR_PANEL_SIZE);
    expect(applied.frame.y).toBeGreaterThanOrEqual(25);
  });

  test("restore without a saved position adopts the current panel frame", async () => {
    window_.panelFrame = rect(300, 300, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);
    await machine.restore();

    const applied = lastSetState(window_);
    expect(applied.frame).toEqual(
      rect(300, 300, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE),
    );
  });

  test("expand/collapse preserves the avatar anchor (anti-blink sequencing)", async () => {
    window_.panelFrame = rect(600, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);
    await machine.syncFromPanel();

    const layout = await machine.computeExpanded();
    // Layout computed WITHOUT any native setState (the anti-blink contract):
    expect(window_.setStates).toHaveLength(0);

    await machine.applyExpanded(layout);
    expect(machine.mode).toBe("expanded");
    // Avatar's global position inside the expanded window is unchanged.
    expect({
      x: layout.avatarRect.x + layout.windowFrame.x,
      y: layout.avatarRect.y + layout.windowFrame.y,
    }).toEqual({ x: 600, y: 700 });

    await machine.collapse();
    expect(machine.mode).toBe("avatar");
    const collapsed = lastSetState(window_);
    expect(collapsed.expanded).toBe(false);
    expect(collapsed.frame).toEqual(
      rect(600, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE),
    );
  });

  test("recomputing while expanded does not adopt the expanded window as the avatar frame", async () => {
    window_.panelFrame = rect(600, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);
    await machine.syncFromPanel();

    const layout = await machine.computeExpanded({ width: 380, height: 96 });
    await machine.applyExpanded(layout);
    expect(window_.panelFrame).toEqual(layout.windowFrame);

    const grown = await machine.computeExpanded({ width: 500, height: 520 });

    expect({
      x: grown.avatarRect.x + grown.windowFrame.x,
      y: grown.avatarRect.y + grown.windowFrame.y,
      width: grown.avatarRect.width,
      height: grown.avatarRect.height,
    }).toEqual(rect(600, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE));

    await machine.applyExpanded(grown);
    await machine.collapse();

    expect(lastSetState(window_)).toEqual({
      expanded: false,
      frame: rect(600, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE),
    });
  });

  test("computeGrown reuses cached avatar without syncing from the expanded panel", async () => {
    window_.panelFrame = rect(600, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);
    await machine.syncFromPanel();

    const composer = await machine.computeExpanded(
      { width: 380, height: 96 },
      "side",
    );
    await machine.applyExpanded(composer);
    window_.calls = [];

    const grown = await machine.computeGrown({
      fromPopoverGlobal: rect(
        composer.windowFrame.x + composer.popoverRect.x,
        composer.windowFrame.y + composer.popoverRect.y,
        composer.popoverRect.width,
        composer.popoverRect.height,
      ),
      composerBottomGlobal:
        composer.windowFrame.y +
        composer.popoverRect.y +
        composer.popoverRect.height,
      bottomInset: 16,
      fromPopoverSide: composer.popoverSide,
    });

    expect(window_.calls).toEqual(["getScreens"]);
    expect({
      x: grown.avatarRect.x + grown.windowFrame.x,
      y: grown.avatarRect.y + grown.windowFrame.y,
      width: grown.avatarRect.width,
      height: grown.avatarRect.height,
    }).toEqual(rect(600, 700, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE));
  });

  test("computeMenu/applyMenu grows the window but returns to the saved avatar frame", async () => {
    window_.panelFrame = rect(420, 500, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);
    await machine.syncFromPanel();

    const layout = await machine.computeMenu({ width: 438, height: 124 });
    await machine.applyMenu(layout);

    expect(machine.mode).toBe("menu");
    expect(lastSetState(window_)).toEqual({
      expanded: true,
      frame: layout.windowFrame,
    });

    await machine.collapse();

    expect(machine.mode).toBe("avatar");
    expect(lastSetState(window_)).toEqual({
      expanded: false,
      frame: rect(420, 500, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE),
    });
  });

  test("onDragEnded clamps and persists the new position", async () => {
    await machine.restore();
    // Simulate the OS drag leaving the panel hanging off the bottom edge.
    window_.panelFrame = rect(200, 880, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);

    await machine.onDragEnded();

    // Clamped back inside the visible frame (bottom = 25 + 815 = 840).
    const applied = lastSetState(window_);
    expect(applied.frame.y).toBe(840 - AVATAR_PANEL_SIZE);
    expect(store.saved).toEqual({ x: 200, y: 840 - AVATAR_PANEL_SIZE });
  });

  test("onDragEnded skips setState when position is already legal", async () => {
    await machine.restore();
    const before = window_.setStates.length;
    window_.panelFrame = rect(400, 400, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);

    await machine.onDragEnded();

    expect(window_.setStates.length).toBe(before); // no extra setState
    expect(store.saved).toEqual({ x: 400, y: 400 });
  });

  test("onDragEndedPerched syncs from panel without saving free position", async () => {
    // the prototype case: native perch placement owns the panel; the free-position
    // store must not learn the perched coordinates.
    window_.panelFrame = rect(450, 120, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);

    await machine.onDragEndedPerched();
    await machine.collapse();

    expect(window_.panelFrame).toEqual(
      rect(450, 120, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE),
    );
    expect(store.saved).toBeNull();
    expect(window_.calls).toEqual(["getPanelFrame", "setState"]);
  });

  test("returnToSavedPosition restores the saved free position, clamped", async () => {
    store.saved = { x: 5000, y: -200 }; // stale off-screen save
    await machine.returnToSavedPosition();

    const applied = lastSetState(window_);
    expect(applied.expanded).toBe(false);
    expect(applied.frame.x).toBeLessThanOrEqual(1440 - AVATAR_PANEL_SIZE);
    expect(applied.frame.y).toBeGreaterThanOrEqual(25);
    expect(machine.mode).toBe("avatar");
  });

  test("returnToSavedPosition without a save adopts the current frame", async () => {
    window_.panelFrame = rect(333, 444, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);
    await machine.returnToSavedPosition();

    const applied = lastSetState(window_);
    expect(applied.frame).toEqual(
      rect(333, 444, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE),
    );
  });

  test("returnToSavedPosition is ignored while menu is open", async () => {
    await machine.syncFromPanel();
    const layout = await machine.computeMenu({ width: 438, height: 124 });
    await machine.applyMenu(layout);
    const statesBefore = window_.setStates.length;

    await machine.returnToSavedPosition();

    expect(machine.mode).toBe("menu");
    expect(window_.setStates.length).toBe(statesBefore);
  });

  test("returnToSavedPosition is ignored while expanded", async () => {
    // the prototype case: an in-progress popover must not be yanked to avatar size.
    await machine.syncFromPanel();
    const layout = await machine.computeExpanded();
    await machine.applyExpanded(layout);
    const statesBefore = window_.setStates.length;

    await machine.returnToSavedPosition();

    expect(machine.mode).toBe("expanded");
    expect(window_.setStates.length).toBe(statesBefore); // untouched
  });

  test("drag is rejected while expanded", async () => {
    await machine.syncFromPanel();
    const layout = await machine.computeExpanded();
    await machine.applyExpanded(layout);

    await expect(machine.onDragStarted()).rejects.toThrow();
    await expect(machine.onDragEnded()).rejects.toThrow();
  });
});
