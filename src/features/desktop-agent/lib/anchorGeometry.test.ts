// Ported from the prototype's test/shell/anchor_geometry_test.dart — same cases,
// same geometry, same expectations.

import { describe, expect, test } from "vitest";

import {
  clampAvatarToScreens,
  computeExpandedLayout,
  inflate,
  POPOVER_SHADOW_MARGIN,
  rect,
  rectBottom,
  rectContains,
  rectRight,
  screenContaining,
  type ScreenInfo,
} from "./anchorGeometry";

const mainScreen: ScreenInfo = {
  frame: rect(0, 0, 1440, 900),
  visibleFrame: rect(0, 25, 1440, 875),
  isMain: true,
};

const sideScreen: ScreenInfo = {
  frame: rect(1440, 0, 1920, 1080),
  visibleFrame: rect(1440, 0, 1920, 1080),
};

const screens = [mainScreen, sideScreen];

describe("screenContaining", () => {
  test("returns the screen containing the point", () => {
    expect(screenContaining({ x: 100, y: 100 }, screens)).toBe(mainScreen);
    expect(screenContaining({ x: 1500, y: 100 }, screens)).toBe(sideScreen);
  });

  test("falls back to the main screen for off-screen points", () => {
    expect(screenContaining({ x: -500, y: -500 }, screens)).toBe(mainScreen);
  });

  test("falls back to the first screen when no main is flagged", () => {
    const noMain: ScreenInfo[] = [
      { frame: rect(0, 0, 100, 100), visibleFrame: rect(0, 0, 100, 100) },
      { frame: rect(100, 0, 100, 100), visibleFrame: rect(100, 0, 100, 100) },
    ];
    expect(screenContaining({ x: -1, y: -1 }, noMain)).toBe(noMain[0]);
  });
});

describe("clampAvatarToScreens", () => {
  const avatar = rect(200, 200, 90, 90);

  test("leaves a fully visible avatar unchanged", () => {
    expect(clampAvatarToScreens(avatar, screens)).toEqual(avatar);
  });

  test("clamps an avatar hanging past the bottom edge onto the screen", () => {
    const hanging = rect(200, 880, 90, 90);
    const clamped = clampAvatarToScreens(hanging, screens);
    expect(rectBottom(clamped)).toBe(rectBottom(mainScreen.visibleFrame));
    expect(clamped.x).toBe(200);
  });

  test("clamps an avatar under the menu bar down into the visible frame", () => {
    const underMenuBar = rect(200, 0, 90, 90);
    const clamped = clampAvatarToScreens(underMenuBar, screens);
    expect(clamped.y).toBe(mainScreen.visibleFrame.y);
  });

  test("keeps a mostly off-screen avatar attached to its nearest screen", () => {
    const mostlyOff = rect(1400, 850, 90, 90);
    const clamped = clampAvatarToScreens(mostlyOff, screens);
    const center = { x: clamped.x + 45, y: clamped.y + 45 };
    const container = screenContaining(center, screens);
    expect(rectContains(container.visibleFrame, center)).toBe(true);
    expect(rectRight(clamped)).toBeLessThanOrEqual(
      rectRight(container.visibleFrame),
    );
  });
});

describe("computeExpandedLayout", () => {
  const popoverSize = { width: 380, height: 520 };

  test("avatar global position is invariant across expansion", () => {
    const avatar = rect(600, 700, 90, 90);
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize,
      screens,
    });
    expect({
      x: layout.avatarRect.x + layout.windowFrame.x,
      y: layout.avatarRect.y + layout.windowFrame.y,
      width: layout.avatarRect.width,
      height: layout.avatarRect.height,
    }).toEqual(avatar);
  });

  test("opens above when the avatar is in the lower half", () => {
    const avatar = rect(600, 750, 90, 90);
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize,
      screens,
    });
    expect(layout.popoverAbove).toBe(true);
    expect(rectBottom(layout.popoverRect)).toBeLessThanOrEqual(
      layout.avatarRect.y,
    );
  });

  test("opens below when the avatar is in the upper half", () => {
    const avatar = rect(600, 100, 90, 90);
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize,
      screens,
    });
    expect(layout.popoverAbove).toBe(false);
    expect(layout.popoverRect.y).toBeGreaterThanOrEqual(
      rectBottom(layout.avatarRect),
    );
  });

  test("popover stays fully on-screen in all four corners", () => {
    const corners = [
      rect(0, 25, 90, 90),
      rect(1350, 25, 90, 90),
      rect(0, 810, 90, 90),
      rect(1350, 810, 90, 90),
    ];
    for (const avatar of corners) {
      const layout = computeExpandedLayout({
        avatarGlobal: avatar,
        popoverSize,
        screens,
      });
      const popGlobal = rect(
        layout.popoverRect.x + layout.windowFrame.x,
        layout.popoverRect.y + layout.windowFrame.y,
        layout.popoverRect.width,
        layout.popoverRect.height,
      );
      expect(popGlobal.x).toBeGreaterThanOrEqual(mainScreen.visibleFrame.x);
      expect(rectRight(popGlobal)).toBeLessThanOrEqual(
        rectRight(mainScreen.visibleFrame),
      );
    }
  });

  test("short screen above placement does not throw and stays visible", () => {
    const shortScreen: ScreenInfo = {
      frame: rect(0, 0, 800, 400),
      visibleFrame: rect(0, 25, 800, 375),
      isMain: true,
    };
    const avatar = rect(300, 280, 90, 90);
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize,
      screens: [shortScreen],
    });
    const popGlobal = rect(
      layout.popoverRect.x + layout.windowFrame.x,
      layout.popoverRect.y + layout.windowFrame.y,
      layout.popoverRect.width,
      layout.popoverRect.height,
    );
    expect(popGlobal.y).toBeGreaterThanOrEqual(12);
    // Anchor invariant holds even in degenerate space.
    expect({
      x: layout.avatarRect.x + layout.windowFrame.x,
      y: layout.avatarRect.y + layout.windowFrame.y,
    }).toEqual({ x: avatar.x, y: avatar.y });
  });

  test("popover never occludes the avatar, in any corner or edge", () => {
    // Near screen corners the vertical clamp used to slide the
    // popover back over the avatar. Sweep positions across the visible
    // frame and assert the no-occlusion invariant everywhere.
    const size = 45;
    const positions: Array<{ x: number; y: number }> = [];
    for (const x of [0, 360, 720, 1080, 1440 - size]) {
      for (const y of [25, 240, 460, 680, 900 - size]) {
        positions.push({ x, y });
      }
    }
    for (const pos of positions) {
      const avatar = rect(pos.x, pos.y, size, size);
      const layout = computeExpandedLayout({
        avatarGlobal: avatar,
        popoverSize,
        screens,
      });
      const overlaps =
        layout.popoverRect.x < rectRight(layout.avatarRect) &&
        layout.avatarRect.x < rectRight(layout.popoverRect) &&
        layout.popoverRect.y < rectBottom(layout.avatarRect) &&
        layout.avatarRect.y < rectBottom(layout.popoverRect);
      expect(overlaps, `popover occludes avatar at (${pos.x},${pos.y})`).toBe(
        false,
      );
      // The anchor invariant must survive the fallback too.
      expect({
        x: layout.avatarRect.x + layout.windowFrame.x,
        y: layout.avatarRect.y + layout.windowFrame.y,
      }).toEqual({ x: avatar.x, y: avatar.y });
    }
  });

  test("degenerate case: popover wider than screen still leaves avatar clickable", () => {
    // When the popover cannot fit beside the avatar at all, the side
    // clamp used to land back on top of it. Last resort slides
    // vertically off the avatar instead.
    const tinyScreen: ScreenInfo = {
      frame: rect(0, 0, 400, 700),
      visibleFrame: rect(0, 25, 400, 675),
      isMain: true,
    };
    const avatar = rect(180, 340, 45, 45); // dead center
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize, // 380 wide on a 400-wide screen: side placement impossible
      screens: [tinyScreen],
    });
    const overlaps =
      layout.popoverRect.x < rectRight(layout.avatarRect) &&
      layout.avatarRect.x < rectRight(layout.popoverRect) &&
      layout.popoverRect.y < rectBottom(layout.avatarRect) &&
      layout.avatarRect.y < rectBottom(layout.popoverRect);
    expect(overlaps).toBe(false);
  });

  test("mid-edge fallback places the popover beside the avatar", () => {
    // Left edge, vertical middle: neither above nor below fits the 520pt
    // popover, so the vertical clamp used to slide it over the avatar.
    // Now it must sit to the avatar's right (the side with room).
    const avatar = rect(0, 460, 45, 45);
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize,
      screens,
    });
    expect(layout.popoverRect.x).toBeGreaterThanOrEqual(
      rectRight(layout.avatarRect),
    );
  });

  test("window frame bounds both the avatar and the popover", () => {
    const avatar = rect(600, 700, 90, 90);
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize,
      screens,
    });
    expect(layout.avatarRect.x).toBeGreaterThanOrEqual(0);
    expect(layout.avatarRect.y).toBeGreaterThanOrEqual(0);
    expect(layout.popoverRect.x).toBeGreaterThanOrEqual(0);
    expect(layout.popoverRect.y).toBeGreaterThanOrEqual(0);
    expect(rectRight(layout.avatarRect)).toBeLessThanOrEqual(
      layout.windowFrame.width,
    );
    expect(rectBottom(layout.avatarRect)).toBeLessThanOrEqual(
      layout.windowFrame.height,
    );
    expect(rectRight(layout.popoverRect)).toBeLessThanOrEqual(
      layout.windowFrame.width,
    );
    expect(rectBottom(layout.popoverRect)).toBeLessThanOrEqual(
      layout.windowFrame.height,
    );
  });
});

describe("popover shadow margin", () => {
  test("window contains the inflated popover while avatar global rect is unchanged", () => {
    const avatar = rect(600, 700, 90, 90);
    const layout = computeExpandedLayout({
      avatarGlobal: avatar,
      popoverSize: { width: 380, height: 520 },
      screens,
    });
    const inflatedPopover = inflate(layout.popoverRect, POPOVER_SHADOW_MARGIN);

    expect(inflatedPopover.x).toBeGreaterThanOrEqual(0);
    expect(inflatedPopover.y).toBeGreaterThanOrEqual(0);
    expect(rectRight(inflatedPopover)).toBeLessThanOrEqual(
      layout.windowFrame.width,
    );
    expect(rectBottom(inflatedPopover)).toBeLessThanOrEqual(
      layout.windowFrame.height,
    );
    expect({
      x: layout.avatarRect.x + layout.windowFrame.x,
      y: layout.avatarRect.y + layout.windowFrame.y,
      width: layout.avatarRect.width,
      height: layout.avatarRect.height,
    }).toEqual(avatar);
  });
});
