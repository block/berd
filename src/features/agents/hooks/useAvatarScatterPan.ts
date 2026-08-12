import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ScatterItemLayout } from "@/features/agents/lib/avatarScatter";

/**
 * Infinite-canvas panning for the avatar scatter field.
 *
 * Owns the imperative half of the collection canvas: pointer/wheel panning,
 * the per-tile wrap transform, and the arrival animation for tiles that pan
 * into view. Extracted from `AvatarCollectionOverlay` so the overlay component
 * is left with composition and rendering.
 *
 * This hook writes to tile DOM nodes directly and deliberately never calls
 * `setState` during a pan — an earlier version re-rendered ~20 video tiles per
 * pointer move and stuttered. The only React state here is `dragging`, which
 * flips at most twice per gesture (cursor affordance).
 *
 * It reads one class from the markup it drives: `.avatar-scatter-media`, the
 * element the arrival animation runs on. Callers must keep registered tile
 * nodes containing that element (pinned by the overlay's DOM-contract tests).
 */
export interface AvatarScatterPanOptions {
  /** Canvas element that receives wheel events. */
  canvasRef: React.RefObject<HTMLDivElement | null>;
  /** Tile placements in cell coordinates. */
  layout: readonly ScatterItemLayout[];
  /** Layout cell size: the viewport oversized by `panMargin` per side. */
  cellWidth: number;
  cellHeight: number;
  panMargin: number;
  /** False while a non-canvas step (prompt, review, exit) owns the surface. */
  panEnabled: boolean;
  /** Changing this recenters the pan for a fresh canvas. */
  resetKey: string | null;
}

export interface AvatarScatterPanState {
  /** True mid-drag, for the grab/grabbing cursor. */
  dragging: boolean;
  /** Ref callback registering a tile's wrapper node by avatar id. */
  registerTileNode: (id: string) => (node: HTMLElement | null) => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  /** Bind to both pointerup and pointercancel. */
  endDrag: (event: React.PointerEvent) => void;
  /** Bind to onClickCapture so a pan does not register as a tile click. */
  suppressClickAfterDrag: (event: React.MouseEvent) => void;
}

/** Pointer travel, in px, before a press becomes a pan. */
const DRAG_THRESHOLD_PX = 4;

export function useAvatarScatterPan({
  canvasRef,
  layout,
  cellWidth,
  cellHeight,
  panMargin,
  panEnabled,
  resetKey,
}: AvatarScatterPanOptions): AvatarScatterPanState {
  // Pan offset, px. Mutated imperatively and applied straight to each tile's
  // transform on every pointer move, so dragging never re-renders React.
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  // Whether the next click (dispatched after pointerup) follows a real pan and
  // must be swallowed. Kept outside dragRef because endDrag clears that before
  // the browser delivers the click.
  const suppressNextClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  // Tile DOM nodes by avatar id, registered via ref callbacks. applyPan writes
  // each tile's wrap translation directly into these.
  const tileNodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const registerTileNode = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) {
        tileNodesRef.current.set(id, node);
      } else {
        tileNodesRef.current.delete(id);
      }
    },
    [],
  );

  // Whether each tile currently intersects the viewport, by id. Maintained
  // imperatively so tiles that pan *into* view can replay their entrance. The
  // first pass after a canvas reset only seeds the map — tiles already on
  // screen animate via their initial CSS entrance, not a replay.
  const tileVisibilityRef = useRef<Map<string, boolean>>(new Map());
  const seedTileVisibilityRef = useRef(true);

  /**
   * Write each tile's wrapped pan translation straight into its DOM node.
   * Every tile keeps its layout position as `left`/`top` and wraps
   * independently: its panned center is folded modulo the cell size, and the
   * difference from the base position becomes a compositor-only transform.
   * Dragging any distance in any direction always lands on the real tiles —
   * live media, hover-to-play — with no duplicate copies. A tile teleports
   * edge-to-edge only while its center crosses the seam at the cell origin,
   * which sits one pan margin off-screen, so the jump is never visible.
   * ~20 style writes per pointer move, no React renders.
   *
   * Tiles that cross from outside the viewport to inside replay the pop-in
   * entrance (staggered when several arrive in the same move), so panning
   * materializes new avatars the same way the first load does instead of
   * revealing a field that was silently "already there".
   */
  const applyPan = useCallback(() => {
    if (cellWidth === 0 || cellHeight === 0) {
      return;
    }
    // Viewport edges in cell coordinates: the field is offset by -panMargin,
    // so the visible window spans [panMargin, cell - panMargin] on each axis.
    const viewLeft = panMargin;
    const viewTop = panMargin;
    const viewRight = cellWidth - panMargin;
    const viewBottom = cellHeight - panMargin;
    const seeding = seedTileVisibilityRef.current;
    const entering: HTMLElement[] = [];

    for (const item of layout) {
      const node = tileNodesRef.current.get(item.id);
      if (!node) {
        continue;
      }
      const wrappedX =
        (((item.x + panRef.current.x) % cellWidth) + cellWidth) % cellWidth;
      const wrappedY =
        (((item.y + panRef.current.y) % cellHeight) + cellHeight) % cellHeight;
      node.style.transform = `translate3d(${wrappedX - item.x}px, ${wrappedY - item.y}px, 0)`;

      const half = item.size / 2;
      const visible =
        wrappedX + half > viewLeft &&
        wrappedX - half < viewRight &&
        wrappedY + half > viewTop &&
        wrappedY - half < viewBottom;
      const wasVisible = tileVisibilityRef.current.get(item.id) ?? false;
      tileVisibilityRef.current.set(item.id, visible);
      if (visible && !wasVisible && !seeding) {
        entering.push(node);
      }
    }
    seedTileVisibilityRef.current = false;

    // Arriving tiles get a little "boop" (see avatar-scatter-boop), not a
    // replay of the first-load launch pop — during a pan the user's hand is
    // already moving the field, so any big scale travel on top of that reads
    // as jumpy. The base delay + `backwards` fill hold the tile invisible for
    // a beat after it crosses the edge, so the boop lands just after the pan
    // instead of already being mid-fade as it arrives.
    //
    // The animation runs on the tile's media element, NOT the wrapper node:
    // the wrapper's inline transform is its wrap translation, and CSS `scale`
    // composes before `transform`, so scaling the wrapper scales that
    // translation too — tiles would appear displaced and slide into place
    // ("spawning from the center"). See the keyframes' comment.
    //
    // Clear the animation and force a reflow so back-and-forth pans can
    // retrigger it. Inline styles only — no React renders — and under reduced
    // motion the stylesheet's `animation: none !important` on
    // `.avatar-scatter-media` still beats this inline shorthand.
    entering.forEach((node, index) => {
      const media = node.querySelector<HTMLElement>(".avatar-scatter-media");
      if (!media) {
        return;
      }
      media.style.animation = "none";
      void media.offsetWidth;
      media.style.animation = `avatar-scatter-boop 0.25s ease-out ${
        125 + index * 40
      }ms backwards`;
    });
  }, [cellWidth, cellHeight, layout, panMargin]);

  // Fresh canvas per collection: recenter the pan. Also runs when the layout
  // lands (tile nodes register before applyPan's memo updates).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the reset trigger, not an input.
  useLayoutEffect(() => {
    panRef.current = { x: 0, y: 0 };
    tileVisibilityRef.current.clear();
    seedTileVisibilityRef.current = true;
    applyPan();
  }, [applyPan, resetKey]);

  // Two-finger trackpad panning: wheel deltas move the field exactly like a
  // drag (content follows the fingers). Attached natively because React's
  // wheel listeners are passive — preventDefault would be ignored and the
  // page would rubber-band/back-swipe behind the overlay.
  useEffect(() => {
    const node = canvasRef.current;
    if (!node || !panEnabled) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      panRef.current = {
        x: panRef.current.x - event.deltaX,
        y: panRef.current.y - event.deltaY,
      };
      applyPan();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [applyPan, canvasRef, panEnabled]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Left/middle only; let buttons receive their own clicks (the drag
      // threshold below decides whether this pan swallows them).
      if (!panEnabled || event.button > 1) {
        return;
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: panRef.current.x,
        originY: panRef.current.y,
        moved: false,
      };
    },
    [panEnabled],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD_PX) {
        drag.moved = true;
        setDragging(true);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      }
      if (drag.moved) {
        panRef.current = {
          x: drag.originX + deltaX,
          y: drag.originY + deltaY,
        };
        applyPan();
      }
    },
    [applyPan],
  );

  const endDrag = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    // pointerup fires before the follow-up click, so remember whether this
    // drag actually panned; suppressClickAfterDrag consumes the flag when the
    // click arrives.
    suppressNextClickRef.current = drag.moved;
    dragRef.current = null;
    setDragging(false);
  }, []);

  const suppressClickAfterDrag = useCallback((event: React.MouseEvent) => {
    // A pan that actually moved must not count as a tile click. The flag is
    // recorded at pointerup (before the browser dispatches the click) and
    // consumed here so the next real click is unaffected.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  return {
    dragging,
    registerTileNode,
    onPointerDown,
    onPointerMove,
    endDrag,
    suppressClickAfterDrag,
  };
}
