// Anchor geometry — ported from the prototype's lib/shell/anchor_geometry.dart.
//
// All coordinates are GLOBAL TOP-LEFT. The Rust side
// (coordinate_space.rs) is the sole authority for AppKit flips; this layer
// never sees bottom-left coordinates.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A display in global top-left coordinates. */
export interface ScreenInfo {
  /** Full screen bounds. */
  frame: Rect;
  /** Bounds excluding the menu bar, notch, and Dock. */
  visibleFrame: Rect;
  isMain?: boolean;
}

/**
 * Geometry for the expanded (popover) state.
 *
 * The invariant: the avatar must not move on screen when the popover opens.
 * The window grows to the bounding box of the avatar and the popover card,
 * and both are positioned inside it.
 */
export interface ExpandedLayout {
  /** New panel frame in global top-left coordinates. */
  windowFrame: Rect;
  /** Avatar position within the window (local coordinates). */
  avatarRect: Rect;
  /** Popover card position within the window (local coordinates). */
  popoverRect: Rect;
  /** Whether the popover opens above the avatar; ignored for side placement. */
  popoverAbove: boolean;
  /** Side placement used for the popover, or null for vertical placement. */
  popoverSide: "left" | "right" | null;
}

export const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
): Rect => ({
  x,
  y,
  width,
  height,
});

export const rectRight = (r: Rect): number => r.x + r.width;
export const rectBottom = (r: Rect): number => r.y + r.height;
export const rectCenter = (r: Rect): { x: number; y: number } => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

export function popoverGlobal(layout: ExpandedLayout): Rect {
  return rect(
    layout.windowFrame.x + layout.popoverRect.x,
    layout.windowFrame.y + layout.popoverRect.y,
    layout.popoverRect.width,
    layout.popoverRect.height,
  );
}

export function rectContains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x < rectRight(r) && p.y >= r.y && p.y < rectBottom(r);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < rectRight(b) &&
    b.x < rectRight(a) &&
    a.y < rectBottom(b) &&
    b.y < rectBottom(a)
  );
}

/**
 * Breathing room the window frame reserves around the popover card so its
 * CSS box-shadow isn't clipped at the window edge (the card used to fill
 * the window region exactly, cropping the shadow). Covers the largest
 * shadow in desktop-agent.css (0 8px 32px).
 */
export const POPOVER_SHADOW_MARGIN = 24;

/** Rect grown by `amount` on every side. */
export function inflate(r: Rect, amount: number): Rect {
  return rect(
    r.x - amount,
    r.y - amount,
    r.width + 2 * amount,
    r.height + 2 * amount,
  );
}

/** Bounding box of two rects. */
export function expandToInclude(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return rect(
    x,
    y,
    Math.max(rectRight(a), rectRight(b)) - x,
    Math.max(rectBottom(a), rectBottom(b)) - y,
  );
}

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Returns the screen whose visible frame contains the point, the main
 * screen, or the first screen, in that order of preference.
 */
export function screenContaining(
  point: { x: number; y: number },
  screens: ScreenInfo[],
): ScreenInfo {
  if (screens.length === 0)
    throw new Error("screenContaining requires screens");
  for (const screen of screens) {
    if (rectContains(screen.visibleFrame, point)) return screen;
  }
  return screens.find((s) => s.isMain) ?? screens[0];
}

/**
 * Clamps the avatar fully within the visible frame of the nearest screen.
 * Used on launch (restored position may reference a disconnected display)
 * and after drags.
 */
export function clampAvatarToScreens(
  avatar: Rect,
  screens: ScreenInfo[],
): Rect {
  const screen = screenContaining(rectCenter(avatar), screens);
  const visible = screen.visibleFrame;
  const x = clampNumber(avatar.x, visible.x, rectRight(visible) - avatar.width);
  const y = clampNumber(
    avatar.y,
    visible.y,
    rectBottom(visible) - avatar.height,
  );
  return rect(x, y, avatar.width, avatar.height);
}

function clampPopoverOrigin(args: {
  requested: number;
  visibleStart: number;
  visibleEnd: number;
  popoverExtent: number;
  margin: number;
}): number {
  const min = args.visibleStart + args.margin;
  const max = args.visibleEnd - args.margin - args.popoverExtent;
  if (min > max) return min;
  return clampNumber(args.requested, min, max);
}

/**
 * Grows a side-placed composer-only popover into the full chat in place:
 * same x, and the full layout's composer pill bottom lands where the
 * composer-only pill's bottom was (the transcript appears above it).
 * Only clamps vertically when the full height won't fit on-screen.
 * Vertical (non-side) composer layouts fall back to computeExpandedLayout.
 */
export function computeGrownLayout(args: {
  avatarGlobal: Rect;
  fromPopoverGlobal: Rect;
  composerBottomGlobal: number;
  popoverSize: Size;
  screens: ScreenInfo[];
  /** Bottom distance from the full popover border box to the composer pill. */
  bottomInset: number;
  /** Side placement of the composer-only layout; null keeps legacy vertical growth. */
  fromPopoverSide: "left" | "right" | null;
}): ExpandedLayout {
  const {
    avatarGlobal,
    fromPopoverGlobal,
    composerBottomGlobal,
    popoverSize,
    screens,
    bottomInset,
    fromPopoverSide,
  } = args;
  const margin = 12;

  if (fromPopoverSide === null) {
    return computeExpandedLayout({ avatarGlobal, popoverSize, screens });
  }

  const screen = screenContaining(rectCenter(avatarGlobal), screens);
  const visible = screen.visibleFrame;
  const requestedTop = composerBottomGlobal + bottomInset - popoverSize.height;
  const clampedTop = clampPopoverOrigin({
    requested: requestedTop,
    visibleStart: visible.y,
    visibleEnd: rectBottom(visible),
    popoverExtent: popoverSize.height,
    margin,
  });

  return expandedLayoutFromGlobals({
    avatarGlobal,
    popoverGlobal: rect(
      fromPopoverGlobal.x,
      clampedTop,
      popoverSize.width,
      popoverSize.height,
    ),
    popoverAbove: false,
    popoverSide: fromPopoverSide,
  });
}

export type ExpandedPlacement = "vertical" | "side";

function expandedLayoutFromGlobals(args: {
  avatarGlobal: Rect;
  popoverGlobal: Rect;
  popoverAbove: boolean;
  popoverSide: "left" | "right" | null;
}): ExpandedLayout {
  const { avatarGlobal, popoverGlobal } = args;
  // The window grows past the popover by the shadow margin so the card's
  // box-shadow has room to paint. Only the WINDOW inflates — the popover
  // and avatar keep their global rects, so nothing moves on screen.
  const windowGlobal = expandToInclude(
    avatarGlobal,
    inflate(popoverGlobal, POPOVER_SHADOW_MARGIN),
  );

  return {
    windowFrame: windowGlobal,
    avatarRect: rect(
      avatarGlobal.x - windowGlobal.x,
      avatarGlobal.y - windowGlobal.y,
      avatarGlobal.width,
      avatarGlobal.height,
    ),
    popoverRect: rect(
      popoverGlobal.x - windowGlobal.x,
      popoverGlobal.y - windowGlobal.y,
      popoverGlobal.width,
      popoverGlobal.height,
    ),
    popoverAbove: args.popoverAbove,
    popoverSide: args.popoverSide,
  };
}

function computeSideRoom(args: {
  avatarGlobal: Rect;
  visible: Rect;
  gap: number;
  margin: number;
  popoverWidth: number;
  preferRight: boolean;
}): { side: "left" | "right"; left: number; fits: boolean } {
  const { avatarGlobal, visible, gap, margin, popoverWidth, preferRight } =
    args;
  const roomRight = rectRight(visible) - margin - rectRight(avatarGlobal) - gap;
  const roomLeft = avatarGlobal.x - gap - (visible.x + margin);
  const preferred: "left" | "right" = preferRight ? "right" : "left";
  const fallback: "left" | "right" = preferRight ? "left" : "right";
  const preferredRoom = preferRight ? roomRight : roomLeft;
  const fallbackRoom = preferRight ? roomLeft : roomRight;
  const side =
    preferredRoom >= popoverWidth || preferredRoom >= fallbackRoom
      ? preferred
      : fallback;

  return {
    side,
    left:
      side === "left"
        ? avatarGlobal.x - gap - popoverWidth
        : rectRight(avatarGlobal) + gap,
    fits: (side === "left" ? roomLeft : roomRight) >= popoverWidth,
  };
}

function computeVerticalExpandedLayout(args: {
  avatarGlobal: Rect;
  popoverSize: Size;
  visible: Rect;
  gap: number;
  margin: number;
}): ExpandedLayout {
  const { avatarGlobal, popoverSize, visible, gap, margin } = args;

  // Vertical: "lower half" means center.y past the visible midpoint.
  const preferAbove = rectCenter(avatarGlobal).y > rectCenter(visible).y;
  const spaceAbove = avatarGlobal.y - visible.y - gap - margin;
  const spaceBelow =
    rectBottom(visible) - rectBottom(avatarGlobal) - gap - margin;
  const above = preferAbove
    ? spaceAbove >= popoverSize.height || spaceAbove >= spaceBelow
    : !(spaceBelow >= popoverSize.height || spaceBelow >= spaceAbove);

  const popTopGlobal = above
    ? avatarGlobal.y - gap - popoverSize.height
    : rectBottom(avatarGlobal) + gap;
  const clampedPopTop = clampPopoverOrigin({
    requested: popTopGlobal,
    visibleStart: visible.y,
    visibleEnd: rectBottom(visible),
    popoverExtent: popoverSize.height,
    margin,
  });

  // Horizontal: center on the avatar, clamped to the visible frame.
  const popLeftGlobal = rectCenter(avatarGlobal).x - popoverSize.width / 2;
  const clampedPopLeft = clampPopoverOrigin({
    requested: popLeftGlobal,
    visibleStart: visible.x,
    visibleEnd: rectRight(visible),
    popoverExtent: popoverSize.width,
    margin,
  });

  let popoverGlobal = rect(
    clampedPopLeft,
    clampedPopTop,
    popoverSize.width,
    popoverSize.height,
  );
  let popoverSide: "left" | "right" | null = null;

  // No-occlusion invariant: near screen corners the
  // vertical clamp can slide the popover back over the avatar, hiding the
  // thing you interact with. If the clamped rects overlap, fall back to
  // SIDE placement — beside the avatar on whichever side has more room —
  // keeping the clamped vertical position.
  if (rectsIntersect(popoverGlobal, avatarGlobal)) {
    const sideRoom = computeSideRoom({
      avatarGlobal,
      visible,
      gap,
      margin,
      popoverWidth: popoverSize.width,
      preferRight: true,
    });
    const clampedSideLeft = clampPopoverOrigin({
      requested: sideRoom.left,
      visibleStart: visible.x,
      visibleEnd: rectRight(visible),
      popoverExtent: popoverSize.width,
      margin,
    });
    const sideCandidate = rect(
      clampedSideLeft,
      clampedPopTop,
      popoverSize.width,
      popoverSize.height,
    );
    // Degenerate case (popover wider than the visible frame): the side
    // clamp can land back over the avatar. Last resort: overlap but slide
    // vertically off the avatar so it stays clickable (invariant honest
    // even when the screen genuinely can't fit both side by side).
    if (rectsIntersect(sideCandidate, avatarGlobal)) {
      const below = rectBottom(avatarGlobal) + gap;
      const aboveTop = avatarGlobal.y - gap - popoverSize.height;
      popoverGlobal = rect(
        clampedSideLeft,
        aboveTop >= visible.y + margin ? aboveTop : below,
        popoverSize.width,
        popoverSize.height,
      );
    } else {
      popoverGlobal = sideCandidate;
      popoverSide = sideRoom.side;
    }
  }

  return expandedLayoutFromGlobals({
    avatarGlobal,
    popoverGlobal,
    popoverAbove: above,
    popoverSide,
  });
}

/**
 * Computes the expanded panel layout for an avatar at avatarGlobal.
 *
 * The popover opens above the avatar when the avatar sits in the lower half
 * of its screen's visible frame (and below otherwise), preferring whichever
 * side has room. Horizontally it centers on the avatar, clamped fully
 * on-screen. The avatar's global rect never changes. Composer-only callers
 * may request side placement so the pill sits like a speech bubble beside
 * the avatar.
 */

export function computeExpandedLayout(args: {
  avatarGlobal: Rect;
  popoverSize: Size;
  screens: ScreenInfo[];
  gap?: number;
  margin?: number;
  placement?: ExpandedPlacement;
}): ExpandedLayout {
  const { avatarGlobal, popoverSize, screens } = args;
  const gap = args.gap ?? 8;
  const margin = args.margin ?? 12;

  const screen = screenContaining(rectCenter(avatarGlobal), screens);
  const visible = screen.visibleFrame;

  if (args.placement === "side") {
    const clampedTop = clampPopoverOrigin({
      requested: rectCenter(avatarGlobal).y - popoverSize.height / 2,
      visibleStart: visible.y,
      visibleEnd: rectBottom(visible),
      popoverExtent: popoverSize.height,
      margin,
    });
    const sideRoom = computeSideRoom({
      avatarGlobal,
      visible,
      gap,
      margin,
      popoverWidth: popoverSize.width,
      preferRight: rectCenter(avatarGlobal).x <= rectCenter(visible).x,
    });

    if (sideRoom.fits) {
      return expandedLayoutFromGlobals({
        avatarGlobal,
        popoverGlobal: rect(
          sideRoom.left,
          clampedTop,
          popoverSize.width,
          popoverSize.height,
        ),
        popoverAbove: false,
        popoverSide: sideRoom.side,
      });
    }
  }

  return computeVerticalExpandedLayout({
    avatarGlobal,
    popoverSize,
    visible,
    gap,
    margin,
  });
}
