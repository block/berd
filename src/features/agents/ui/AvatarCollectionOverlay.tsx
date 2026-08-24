import { IconArrowLeft, IconX } from "@tabler/icons-react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { BerdLoaderInline } from "@/shared/ui/berd-loader-inline";
import { Button } from "@/shared/ui/button";
import { CanvasNavButton } from "@/shared/ui/canvas-nav-button";
import { Spinner } from "@/shared/ui/spinner";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import {
  buildCollectionLayout,
  type ScatterItemLayout,
} from "@/features/agents/lib/avatarScatter";
import { useAvatarScatterPan } from "@/features/agents/hooks/useAvatarScatterPan";
import {
  buildAvatarDisplayCollections,
  type AvatarDisplayCollection,
  type AvatarDisplayEntry,
} from "@/features/agents/lib/avatarLibraryView";

/** Exit animation length; keep in sync with .avatar-overlay-exit. */
const OVERLAY_EXIT_MS = 260;

/** Funnel exit length; keep in sync with .avatar-overlay-exit-funnel. */
const OVERLAY_FUNNEL_EXIT_MS = 220;

/**
 * How the takeover leaves:
 * - "fade" — the neutral scrim dismiss (backing out, light-dismiss).
 * - "funnel" — the surface collapses toward the builder rail's status card /
 *   avatar preview, so exits that hand work back to the rail (selecting an
 *   avatar, backgrounding a generation) visibly point at where it went.
 */
type OverlayExitMode = "fade" | "funnel";

/**
 * Marks the rail element the funnel exit collapses toward. The rail puts it
 * on the avatar preview; the overlay reads the
 * first visible match at close time.
 */
export const AVATAR_FUNNEL_TARGET_ATTR = "data-avatar-funnel-target";

/** Center of the funnel target, in viewport px, or null when none exists. */
function findFunnelTargetCenter(): { x: number; y: number } | null {
  const nodes = document.querySelectorAll<HTMLElement>(
    `[${AVATAR_FUNNEL_TARGET_ATTR}]`,
  );
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  }
  return null;
}

/**
 * Margin around the viewport, as a fraction of the item size, by which the
 * layout cell is oversized. Avatars near the cell edges sit half-cut by the
 * window at rest — the Figma edge bleed — and dragging brings them in.
 *
 * Infinite canvas via per-tile wrapping: each tile's position wraps
 * independently modulo the cell size (see applyPan), so dragging any
 * distance in any direction always lands on content, and every visible
 * tile is the real thing — live media, full resolution, hover-to-play.
 * (An earlier version duplicated the whole cell 3x3 with still-snapshot
 * "ghost" copies; the ghosts read as low-res static imposters. Per-tile
 * wrap needs no duplicates at all.)
 *
 * The wrap seam sits at the cell origin, one margin off-screen. A tile
 * teleports edge-to-edge only while its center crosses the seam, so the
 * jump is invisible as long as margin ≥ half an item — hence this factor
 * must stay ≥ 0.5, with headroom for the hover scale-up.
 */
const PAN_MARGIN_ITEM_FACTOR = 0.6;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Positions a scatter item and feeds its entrance timing to the
 * `.avatar-scatter-item` keyframes via a custom property.
 */
function scatterItemStyle(item: ScatterItemLayout): CSSProperties {
  return {
    left: item.x - item.size / 2,
    top: item.y - item.size / 2,
    width: item.size,
    height: item.size,
    "--scatter-pop-delay": `${item.popDelayMs}ms`,
  } as CSSProperties;
}

/** Entrance timing for the collections row tiles. */
function rowItemStyle(index: number): CSSProperties {
  return {
    "--scatter-pop-delay": `${index * 60}ms`,
  } as CSSProperties;
}

const WORDMARK_CLASS =
  "avatar-collection-wordmark text-center font-light leading-[0.96] tracking-[-0.05em] text-foreground/90 text-[clamp(3.25rem,8vw,9.5rem)]";

/**
 * Presentation order for avatar collections.
 */
const COLLECTION_DISPLAY_ORDER = ["gloopies", "pollies", "fuzzies"];

function collectionRank(id: string): number {
  const index = COLLECTION_DISPLAY_ORDER.indexOf(id);
  return index === -1 ? COLLECTION_DISPLAY_ORDER.length : index;
}

const COLLECTION_CARD_CLASS = cn(
  "avatar-scatter-item group relative flex flex-col items-start rounded-[20px] p-5",
  "w-[clamp(11rem,20vw,18.25rem)] aspect-[4/7] max-h-[56vh]",
  "bg-card/85 transition-colors duration-200 hover:bg-card",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);
const COLLECTION_CARD_BADGE_CLASS =
  "rounded-[10px] bg-muted px-1.5 py-0.5 text-sm text-foreground";
const COLLECTION_CARD_LABEL_CLASS =
  "shrink-0 text-left text-2xl leading-[0.96] tracking-[-0.04em] text-foreground/60 transition-colors group-hover:text-foreground/80";

interface AvatarCollectionOverlayProps {
  library: AvatarLibraryState;
  /**
   * Opens the takeover directly on a collection when provided.
   */
  initialCollectionId?: string | null;
  /**
   * Hands the full persisted ref (`app-avatar:<id>` or `user-avatar:<id>`) to
   * the owning editor. A synchronous owner has accepted it into its working
   * buffer; an asynchronous owner can delay dismissal until its own commit
   * boundary succeeds.
   */
  onSelectAvatar: (avatarRef: string) => void | Promise<void>;
  onClose: () => void;
}

interface TileSize {
  width: number;
  height: number;
}

/**
 * Full-surface avatar collection takeover.
 *
 * Renders as a portal over the whole app on the frosted-glass overlay tokens,
 * leaving the chat + builder mounted (and their state intact) underneath.
 * All chrome is centered with the collection wordmark: the back/Select
 * controls sit directly above the title.
 *
 * Two levels:
 * - Collections level — a clean row of collection covers centered under the title.
 * - Collection page — a static scatter field of avatars splayed across the
 *   whole window, bleeding slightly off the edges like the Figma frame; the
 *   wordmark sits fixed in the center.
 *
 * The field is calm by default: avatars sit on a still frame and only play
 * (and wobble) for the hovered or highlighted tile. Picking is two-step —
 * click highlights an avatar (everything else fades back), Select commits —
 * so a stray click on the canvas never changes the agent.
 */
export function AvatarCollectionOverlay({
  library,
  initialCollectionId = null,
  onSelectAvatar,
  onClose,
}: AvatarCollectionOverlayProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [collectionId, setCollectionId] = useState<string | null>(
    initialCollectionId,
  );
  const [pendingAvatarRef, setPendingAvatarRef] = useState<string | null>(null);
  const [hoveredAvatarRef, setHoveredAvatarRef] = useState<string | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const [selectionFailed, setSelectionFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  // Where the funnel exit collapses to (viewport px); null = plain fade.
  const [exitTarget, setExitTarget] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [tileSize, setTileSize] = useState<TileSize | null>(null);
  // Ids whose media has painted at least one real frame. Tiles hold their
  // entrance animation (paused at opacity 0) until then, so the field never
  // pops in as empty boxes that fill in later — each avatar arrives with
  // pixels.
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markReady = useCallback((id: string) => {
    setReadyIds((current) => {
      if (current.has(id)) {
        return current;
      }
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);
  const exitTimerRef = useRef<number | null>(null);

  const collections = useMemo(
    () =>
      buildAvatarDisplayCollections(library).sort(
        (a, b) => collectionRank(a.id) - collectionRank(b.id),
      ),
    [library],
  );
  // A single-collection catalog skips the collections level entirely — the
  // takeover opens straight onto that collection and back closes rather than
  // going up.
  const effectiveCollectionId =
    collectionId ?? (collections.length === 1 ? collections[0].id : null);
  const collection =
    collections.find((entry) => entry.id === effectiveCollectionId) ?? null;
  const hasCollectionsLevel = collections.length > 1;
  const collectionDisplayLabel = useCallback(
    (entry: AvatarDisplayCollection) => entry.label ?? entry.id,
    [],
  );

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    },
    [],
  );

  /**
   * Play an exit animation before handing control back. Every path out of
   * the overlay goes through here so leaving always animates; `closing` also
   * inerts the chrome so double-clicks can't fire two handoffs.
   *
   * "fade" is the neutral scrim dismiss. "funnel" collapses the surface
   * toward the rail's status card / avatar preview (marked with
   * AVATAR_FUNNEL_TARGET_ATTR), for exits that visibly hand work back to the
   * rail — selecting an avatar, or backgrounding a generation. Falls back to
   * fade when no target is on screen.
   */
  const closeWithAnimation = useCallback(
    (after: () => void, mode: OverlayExitMode = "fade") => {
      setClosing((current) => {
        if (current) {
          return current;
        }
        const target = mode === "funnel" ? findFunnelTargetCenter() : null;
        setExitTarget(target);
        exitTimerRef.current = window.setTimeout(
          after,
          target ? OVERLAY_FUNNEL_EXIT_MS : OVERLAY_EXIT_MS,
        );
        return true;
      });
    },
    [],
  );

  const clearPendingSelection = useCallback(() => {
    setPendingAvatarRef(null);
    setSelectionFailed(false);
  }, []);

  const togglePendingSelection = useCallback((avatarRef: string) => {
    setPendingAvatarRef((current) =>
      current === avatarRef ? null : avatarRef,
    );
    setSelectionFailed(false);
  }, []);

  const goBack = useCallback(() => {
    if (closing || selectionPending) {
      return;
    }
    if (collection && hasCollectionsLevel) {
      clearPendingSelection();
      setCollectionId(null);
      return;
    }
    closeWithAnimation(onClose);
  }, [
    clearPendingSelection,
    closing,
    closeWithAnimation,
    collection,
    hasCollectionsLevel,
    onClose,
    selectionPending,
  ]);

  // Esc mirrors the back control at every level.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        goBack();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [goBack]);

  // Size the scatter tile from the actual canvas so density feels similar on
  // any window size. The tile is at least the viewport so a single wrap step
  // never shows a seam.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setTileSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Item size tracks window width at the Figma reference's upper proportion
  // (~15%, "nice and big"), clamped so small windows stay readable and huge
  // ones stay calm. The pan margin extends the layout canvas beyond the
  // viewport on every side.
  const itemSize = tileSize
    ? Math.round(clampNumber(tileSize.width * 0.15, 140, 230))
    : 0;
  const panMargin = Math.round(itemSize * PAN_MARGIN_ITEM_FACTOR);

  const layout = useMemo(() => {
    if (!tileSize || !collection || itemSize === 0) {
      return [];
    }
    // Diagonal-band placements in the spirit of the Figma reference
    // (916-18033), rescaled onto the oversized canvas (viewport + pan
    // margin per side). Items keep a small positive padding against the
    // *canvas* edge, so at full pan every avatar is entirely on screen; at
    // rest the outer ones sit half-cut by the viewport — the Figma edge
    // bleed, now recoverable by dragging. No center keep-out: the field
    // runs straight across the wordmark like the reference (the wordmark
    // renders *behind* the avatars; hover brings a tile further forward).
    return buildCollectionLayout(
      collection.entries.map((entry) => entry.ref),
      tileSize.width + panMargin * 2,
      tileSize.height + panMargin * 2,
      {
        itemSize,
        edgePadding: 8,
        minGap: 24,
      },
    );
  }, [collection, itemSize, panMargin, tileSize]);

  // Empty-canvas clicks (anything that is not a tile, the collections row,
  // or a chrome control) are handled in onCanvasClick: light-dismiss on the
  // collections level, release-the-highlight on collection pages.
  const panEnabled = Boolean(collection) && !closing;

  // Layout cell dimensions: the viewport oversized by the pan margin on
  // each side. This cell repeats in a 3x3 grid, so the canvas is infinite.
  const cellWidth = tileSize ? tileSize.width + panMargin * 2 : 0;
  const cellHeight = tileSize ? tileSize.height + panMargin * 2 : 0;

  // Pointer/wheel panning, the per-tile wrap transform, and the arrival
  // animation all live in this hook; the overlay keeps composition + render.
  const {
    dragging,
    registerTileNode,
    onPointerDown,
    onPointerMove,
    endDrag,
    suppressClickAfterDrag,
  } = useAvatarScatterPan({
    canvasRef,
    layout,
    cellWidth,
    cellHeight,
    panMargin,
    panEnabled,
    resetKey: effectiveCollectionId,
  });

  const onCanvasClick = useCallback(
    (event: React.MouseEvent) => {
      if (closing || selectionPending) {
        return;
      }
      const target = event.target as HTMLElement;
      if (
        target.closest("button") ||
        target.closest("[data-collections-row]")
      ) {
        return;
      }
      if (collection) {
        // On a collection page, clicking empty canvas releases the current
        // highlight — everything fades back up. Deliberately not a dismiss:
        // mis-clicking near an avatar must not throw the user out of the
        // picker.
        clearPendingSelection();
        return;
      }
      // On the collections level, empty-canvas clicks light-dismiss the
      // overlay like a dialog scrim.
      closeWithAnimation(onClose);
    },
    [
      clearPendingSelection,
      closing,
      closeWithAnimation,
      collection,
      onClose,
      selectionPending,
    ],
  );

  const onConfirmSelect = useCallback(() => {
    if (!pendingAvatarRef || closing || selectionPending) {
      return;
    }
    const pendingRef = collection?.entries.find(
      (entry) => entry.ref === pendingAvatarRef,
    )?.ref;
    if (!pendingRef) {
      return;
    }
    setSelectionPending(true);
    setSelectionFailed(false);
    void Promise.resolve(onSelectAvatar(pendingRef))
      .then(() => {
        // The owner decides its acceptance boundary: the builder accepts into
        // its working buffer, while the detail page waits for persistence.
        closeWithAnimation(onClose, "funnel");
      })
      .catch(() => {
        setSelectionFailed(true);
      })
      .finally(() => {
        setSelectionPending(false);
      });
  }, [
    closing,
    closeWithAnimation,
    collection,
    onClose,
    onSelectAvatar,
    pendingAvatarRef,
    selectionPending,
  ]);

  const hoverHandlers = useCallback(
    (avatarRef: string) => ({
      onPointerEnter: () => setHoveredAvatarRef(avatarRef),
      onPointerLeave: () =>
        setHoveredAvatarRef((current) =>
          current === avatarRef ? null : current,
        ),
    }),
    [],
  );

  const renderAvatarItem = useCallback(
    (entry: AvatarDisplayEntry, item: ScatterItemLayout) => {
      const pending = pendingAvatarRef === entry.ref;
      // Highlighting an avatar fades everything else back instead of drawing
      // a ring; the highlighted one stays at full strength (and animates).
      const dimmed = pendingAvatarRef !== null && !pending;
      const cachedMedia = entry.media;
      const label = entry.label ?? t("editor.userGloopieLabel");
      return (
        <div
          className={cn(
            "avatar-scatter-item absolute",
            // Pointed-at or highlighted tiles jump the field's paint order,
            // so an avatar overlapping the wordmark (or a neighbor's bleed)
            // comes fully forward under the cursor.
            "hover:z-10 focus-within:z-10",
            pending && "z-10",
            // Hold the entrance (paused at opacity 0) until the media has
            // painted, so tiles never pop in empty and fill in later.
            cachedMedia && !readyIds.has(entry.ref) && "avatar-scatter-waiting",
          )}
          style={scatterItemStyle(item)}
          ref={registerTileNode(entry.ref)}
        >
          <button
            type="button"
            className={cn(
              "group flex h-full w-full items-center justify-center rounded-2xl",
              "transition-opacity duration-300",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              dimmed && "opacity-25 hover:opacity-60",
              !cachedMedia && "cursor-default",
            )}
            aria-label={label}
            aria-pressed={pending}
            disabled={!cachedMedia || closing || selectionPending}
            {...hoverHandlers(entry.ref)}
            onClick={() => togglePendingSelection(entry.ref)}
          >
            {cachedMedia ? (
              <AvatarMedia
                media={cachedMedia}
                alt=""
                // Eager: tiles near the cell edges start outside the viewport,
                // and a visibility-gated load would leave them blank until a
                // drag reveals them — the half-empty-canvas problem. The
                // field is at most ~20 tiles of 400px media and entrances are
                // already paint-gated, so decode everything up front.
                loadingStrategy="eager"
                // Calm by default: only the hovered or highlighted avatar
                // plays; everything else sits on its first frame.
                paused={hoveredAvatarRef !== entry.ref && !pending}
                className="avatar-scatter-media h-full w-full object-contain"
                onError={() => {}}
                onReady={() => markReady(entry.ref)}
              />
            ) : (
              <span className="max-w-full truncate px-2 text-xs text-muted-foreground">
                {label}
              </span>
            )}
          </button>
          {pending ? (
            // Select rides the highlighted avatar itself, so committing
            // happens where the user is already looking instead of up in the
            // navigation chrome. It shares the tile's wrapper, so it follows
            // the pan (and the wrap seam) with its avatar.
            <div className="absolute inset-x-0 top-full flex justify-center pt-1">
              <Button
                type="button"
                variant="primary"
                feedbackState={selectionPending ? "loading" : "idle"}
                loadingLabel={t("editor.avatarLoading")}
                disabled={closing || selectionPending}
                onClick={onConfirmSelect}
              >
                {t("collectionPage.select")}
              </Button>
            </div>
          ) : null}
        </div>
      );
    },
    [
      closing,
      hoveredAvatarRef,
      hoverHandlers,
      markReady,
      onConfirmSelect,
      pendingAvatarRef,
      readyIds,
      registerTileNode,
      selectionPending,
      t,
      togglePendingSelection,
    ],
  );

  const renderCollectionRowItem = useCallback(
    (entry: AvatarDisplayCollection, index: number) => {
      const cachedMedia = entry.cover?.media;
      const label = collectionDisplayLabel(entry);
      return (
        <button
          key={entry.id}
          type="button"
          className={cn(
            COLLECTION_CARD_CLASS,
            cachedMedia && !readyIds.has(entry.id) && "avatar-scatter-waiting",
          )}
          style={rowItemStyle(index)}
          aria-label={t("collectionPage.openCollection", {
            label,
          })}
          disabled={closing || selectionPending}
          onClick={() => setCollectionId(entry.id)}
        >
          <span className={COLLECTION_CARD_BADGE_CLASS}>
            {t("collectionPage.collectionBadge")}
          </span>
          {/* Cover avatars run big like the reference — ~82% of the card's
            full width, breaking out of the card padding so they read as the
            card's subject rather than a thumbnail floating in it. Always
            animating (no hover gating): unlike the scatter field, the
            collections level has only a handful of covers, so the panning
            lag that forced hover-to-play there doesn't apply. */}
          <span className="-mx-5 flex min-h-0 w-[calc(100%+2.5rem)] flex-1 items-center justify-center">
            {cachedMedia ? (
              <AvatarMedia
                media={cachedMedia}
                alt=""
                lazy
                loadingStrategy="visible-video"
                className="avatar-scatter-media max-h-full w-[82%] object-contain"
                onError={() => {}}
                onReady={() => markReady(entry.id)}
              />
            ) : (
              <Spinner className="size-5 text-muted-foreground" />
            )}
          </span>
          <span className={COLLECTION_CARD_LABEL_CLASS}>{label}</span>
        </button>
      );
    },
    [closing, collectionDisplayLabel, markReady, readyIds, selectionPending, t],
  );

  const heading = collection
    ? t("collectionPage.collectionHeading", {
        label: collectionDisplayLabel(collection),
      })
    : t("collectionPage.collectionsHeading");

  const backLabel =
    collection && hasCollectionsLevel
      ? t("editor.avatarBackToCollections")
      : t("common:actions.close");

  const collectionFailed = library.error || library.mediaError;

  return createPortal(
    // FocusScope gives this hand-rolled takeover the same focus containment
    // the shared Dialog gets from Radix: focus moves into the surface on
    // mount, Tab loops inside it, focus cannot escape to the still-mounted
    // chat/builder UI behind the portal, and it returns to the opener on
    // unmount.
    <FocusScope asChild loop trapped>
      <div
        className={cn(
          // Opaque dot-grid canvas (design feedback): no frosted scrim or
          // backdrop blur — the takeover is its own page, not a veil over
          // the last one.
          "avatar-collection-dot-grid fixed inset-0 z-[70] flex flex-col",
          closing
            ? exitTarget
              ? "avatar-overlay-exit-funnel"
              : "avatar-overlay-exit"
            : "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200",
        )}
        // The funnel collapses toward the rail's status card / avatar preview:
        // transform-origin at the target makes scale() converge on that point.
        style={
          exitTarget
            ? ({
                transformOrigin: `${exitTarget.x}px ${exitTarget.y}px`,
              } as CSSProperties)
            : undefined
        }
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        data-testid="avatar-collection-overlay"
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: scrim-style light dismiss; keyboard users dismiss via the window-level Escape handler. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape (window-level) is the keyboard path for this pointer-only scrim affordance. */}
        <div
          ref={canvasRef}
          className={cn(
            "relative min-h-0 flex-1 touch-none select-none overflow-hidden",
            panEnabled && (dragging ? "cursor-grabbing" : "cursor-grab"),
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClickCapture={suppressClickAfterDrag}
          onClick={onCanvasClick}
        >
          {/* The field sits *above* the wordmark (z-1 vs z-0): avatars run
            straight across the giant text like the Figma reference, and a
            hovered tile lifts further forward within the field. Chrome
            controls float above both at z-2. */}
          {tileSize && collection ? (
            <div
              className="absolute z-[1]"
              // One layout cell, oversized by the pan margin per side. Every
              // tile is real — no duplicate cells — and each wraps its own
              // position modulo the cell size as the pan moves (see applyPan),
              // so the canvas is infinite in every direction.
              style={{
                top: -panMargin,
                left: -panMargin,
                width: cellWidth,
                height: cellHeight,
              }}
            >
              {layout.map((item) => {
                const entry = collection.entries.find(
                  (candidate) => candidate.ref === item.id,
                );
                return entry ? (
                  <div key={item.id} className="contents">
                    {renderAvatarItem(entry, item)}
                  </div>
                ) : null;
              })}
            </div>
          ) : null}

          {/* Centered chrome: controls above the wordmark, and at the
            collections level the row of collections beneath it.
            Deliberately no z-index on these wrappers — they must not form a
            stacking context, so the wordmark (z-0) can sit behind the
            avatar field (z-1) while the controls (z-2) float above it.

            Scroll-safe centering: the outer wrapper scrolls and the inner
            column centers itself with auto margins instead of flex
            centering. `items-center justify-center` clips both ends of
            overflowing content with no way to reach it — at the supported
            minimum window the collection cards wrap to two rows taller
            than the viewport, and auto margins keep the overflow
            scrollable. (Plain overflow, no stacking context.) */}
          <div className="pointer-events-none absolute inset-0 flex overflow-y-auto">
            <div
              className="m-auto flex max-w-[85%] flex-col items-center gap-6 py-8"
              inert={closing ? true : undefined}
            >
              <h1 className={collection ? WORDMARK_CLASS : "sr-only"}>
                {heading}
              </h1>
              {!collection ? (
                <div
                  data-collections-row
                  className="pointer-events-auto flex flex-wrap items-stretch justify-center gap-6 p-6"
                >
                  {collections.map((entry, index) =>
                    renderCollectionRowItem(entry, index),
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {library.loading && !library.catalog ? (
            <div
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <BerdLoaderInline
                size={56}
                decorative
                className="text-foreground"
              />
              <span>{t("editor.avatarLoading")}</span>
            </div>
          ) : null}

          {selectionFailed ? (
            <Alert className="absolute bottom-6 left-1/2 z-10 w-auto max-w-[calc(100%_-_3rem)] -translate-x-1/2">
              <AlertDescription className="grid-cols-[1fr_auto] items-center gap-3">
                <span>{t("builderRail.saveError")}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onConfirmSelect}
                >
                  {t("builderRail.retrySave")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Navigation chrome, per design feedback (Berd-Updates 704-3688):
            one black icon-only circle in the top-right corner. An arrow when
            it goes up a level, an X when it dismisses the takeover outright;
            the label survives as the accessible name. */}
          {!closing ? (
            <div className="pointer-events-auto absolute right-6 top-6 z-10">
              <CanvasNavButton
                type="button"
                size="icon-lg"
                aria-label={backLabel}
                title={backLabel}
                disabled={selectionPending}
                onClick={goBack}
              >
                {collection && hasCollectionsLevel ? (
                  <IconArrowLeft aria-hidden="true" />
                ) : (
                  <IconX aria-hidden="true" />
                )}
              </CanvasNavButton>
            </div>
          ) : null}

          {collectionFailed ? (
            <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface-glass-strong px-4 py-2 text-sm text-surface-glass-strong-fg shadow-[var(--shadow-chat)] backdrop-blur-md">
              <span>
                {library.errorCode === "networkAccess" ||
                library.mediaErrorCode === "networkAccess"
                  ? t("editor.avatarCollectionNetworkAccess")
                  : t("avatar.loadFailed")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  if (library.error) {
                    library.retryCatalog();
                  } else {
                    library.retryMedia();
                  }
                }}
              >
                <RefreshCw className="size-3" aria-hidden="true" />
                {t("editor.avatarRetry")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </FocusScope>,
    document.body,
  );
}
