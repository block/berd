import {
  IconArrowLeft,
  IconCheck,
  IconRefresh,
  IconWand,
  IconX,
} from "@tabler/icons-react";
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
import type {
  AvatarCatalogEntry,
  AvatarCollection,
} from "@/shared/avatars/catalog";
import { getAvatarCatalogEntry } from "@/shared/avatars/catalog";
import { GLOOPIE_PROMPT_MAX_LENGTH } from "@/shared/api/gloopies";
import { cn } from "@/shared/lib/cn";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { GlassButton } from "@/shared/ui/glass-button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Spinner } from "@/shared/ui/spinner";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import {
  buildCollectionLayout,
  type ScatterItemLayout,
} from "@/features/agents/lib/avatarScatter";
import { useAvatarScatterPan } from "@/features/agents/hooks/useAvatarScatterPan";
import { getCachedAvatarMedia } from "@/features/agents/ui/AvatarLibraryPicker";

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
 * on the gloopie status card and on the avatar preview; the overlay reads the
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
 * One generated gloopie option on the takeover glass.
 *
 * Deliberately the same two-step picking model as a collection tile: clicking
 * highlights, the primary chrome button commits. The tile owns its own media
 * subscription because generated refs are `user-avatar:` files that are not in
 * the bundled catalog cache the scatter field reads from.
 */
function GloopieReviewTile({
  avatarRef,
  index,
  total,
  selected,
  dimmed,
  disabled,
  onSelect,
}: {
  avatarRef: string;
  index: number;
  total: number;
  selected: boolean;
  dimmed: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const media = useAvatarMediaState(avatarRef);

  return (
    <button
      type="button"
      className={cn(
        "group relative flex aspect-square w-full items-center justify-center rounded-2xl p-2 transition-opacity",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        dimmed && "opacity-30 hover:opacity-70",
      )}
      aria-label={t("gloopie.optionLabel", { index: index + 1, total })}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      {media.media ? (
        <AvatarMedia
          media={media.media}
          alt=""
          loadingStrategy="eager"
          paused={!selected}
          className="h-full w-full object-contain"
          onError={() => {}}
        />
      ) : (
        <Spinner className="size-5 text-muted-foreground" />
      )}
      {selected ? (
        <span className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <IconCheck className="size-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </button>
  );
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

/**
 * Gloopie "create your own" integration. The prompt step renders inside the
 * overlay on the frosted glass; `start` kicks off generation and `onHandoff`
 * returns control to the builder rail (which shows the in-progress status
 * card) after the overlay's exit animation.
 */
export interface AvatarCollectionGloopieProps {
  object: string;
  setObject: (value: string) => void;
  start: () => void;
  onHandoff: () => void;
  /** True when a previous generation is still in flight or awaiting review. */
  hasActiveWork: boolean;
  /** Opens the rail's full creator for that in-flight work. */
  onOpenActiveWork: () => void;
  /**
   * When true, pressing "Create gloopie" leaves the takeover open so progress
   * and the four options land on this glass instead of handing straight back
   * to the builder rail. Picking an avatar is one job, so it stays on one
   * surface.
   */
  stayOpenWhileGenerating?: boolean;
  /** Rendered instead of the prompt while the backend is producing options. */
  generating?: AvatarCollectionGloopieWaiting;
  /** Rendered while the chosen option is being animated. */
  animating?: AvatarCollectionGloopieWaiting;
  /** Shown on the prompt level after a failed attempt. */
  errorMessage?: string | null;
  /**
   * Present when four generated options are waiting to be picked. Choosing
   * happens on this glass surface — the same canvas the collections and the
   * prompt use — so the whole "pick an avatar" job lives on one surface
   * instead of jumping between the takeover and the builder rail.
   */
  review?: AvatarCollectionGloopieReview;
}

export interface AvatarCollectionGloopieWaiting {
  /** Background the work and return to the builder rail's status card. */
  onContinueSetup: () => void;
  /** Abandon the attempt: delete its media and return to the prompt. */
  onDiscard: () => void;
}

export interface AvatarCollectionGloopieReview {
  options: readonly { id: string; avatarRef: string }[];
  chosenOptionId: string | null;
  /** Pass null to release the current highlight. */
  chooseOption: (optionId: string | null) => void;
  /** Animate the chosen option, then hand back to the builder. */
  animate: () => void;
  /** Throw away these options and generate four more from the same prompt. */
  regenerate: () => void;
  /** Abandon the attempt and return to the prompt. */
  startOver: () => void;
  /** Runs after the exit animation once the user has committed a choice. */
  onHandoff: () => void;
}

interface AvatarCollectionOverlayProps {
  library: AvatarLibraryState;
  /** Collection to open with; null starts at the collections level. */
  initialCollectionId?: string | null;
  /**
   * Open straight onto the "create your own" prompt. Used when the builder
   * rail's status card reopens this surface for a gloopie that is back at the
   * prompt (or failed), so the user lands on the step they left.
   */
  initialCreateOpen?: boolean;
  onSelectAvatar: (avatarId: string) => void;
  onClose: () => void;
  gloopie?: AvatarCollectionGloopieProps;
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
 * - Collections level — a clean row of collection covers (plus "Create your
 *   own") centered under the title, matching the Figma reference.
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
  initialCreateOpen = false,
  onSelectAvatar,
  onClose,
  gloopie,
}: AvatarCollectionOverlayProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [collectionId, setCollectionId] = useState<string | null>(
    initialCollectionId,
  );
  const [createOpen, setCreateOpen] = useState(initialCreateOpen);
  // Which destructive gloopie action is awaiting an "are you sure": discarding
  // an in-flight generation, or throwing away the four generated options.
  const [confirmAction, setConfirmAction] = useState<
    "discard" | "startOver" | null
  >(null);
  const [pendingAvatarId, setPendingAvatarId] = useState<string | null>(null);
  const [hoveredAvatarId, setHoveredAvatarId] = useState<string | null>(null);
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

  const collections = library.catalog?.collections ?? [];
  // A single-collection catalog skips the collections level entirely — the
  // takeover opens straight onto that collection and back closes rather than
  // going up.
  const effectiveCollectionId =
    collectionId ?? (collections.length === 1 ? collections[0].id : null);
  const collection =
    collections.find((entry) => entry.id === effectiveCollectionId) ?? null;
  const hasCollectionsLevel = collections.length > 1;
  const catalogVersion = library.catalog?.catalogVersion;

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

  const goBack = useCallback(() => {
    if (closing) {
      return;
    }
    // An open "are you sure" owns Escape/back: dismiss it, don't act behind it.
    if (confirmAction) {
      setConfirmAction(null);
      return;
    }
    // Review is the deepest level: backing out of it abandons the options and
    // returns to the prompt rather than closing the takeover. Because that
    // throws away four generated gloopies, it asks first instead of acting.
    if (gloopie?.review) {
      setConfirmAction("startOver");
      return;
    }
    // While options or the animation are still rendering there is nothing to go
    // "back" to — the work is already running. Treat back/Escape as "let it
    // finish in the background" rather than a silent no-op or a discard. The
    // funnel exit points at the rail's status card, where the work lands.
    if (gloopie?.generating) {
      closeWithAnimation(gloopie.generating.onContinueSetup, "funnel");
      return;
    }
    if (gloopie?.animating) {
      closeWithAnimation(gloopie.animating.onContinueSetup, "funnel");
      return;
    }
    if (createOpen) {
      setCreateOpen(false);
      return;
    }
    if (collection && hasCollectionsLevel) {
      setPendingAvatarId(null);
      setCollectionId(null);
      return;
    }
    closeWithAnimation(onClose);
  }, [
    closing,
    closeWithAnimation,
    collection,
    confirmAction,
    createOpen,
    gloopie?.animating,
    gloopie?.generating,
    gloopie?.review,
    hasCollectionsLevel,
    onClose,
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

  // Ensure assets for the open collection are cached (download on demand).
  const openCollectionRef = useRef(library.openCollection);
  openCollectionRef.current = library.openCollection;
  useEffect(() => {
    if (collection) {
      void openCollectionRef.current(collection);
    }
  }, [collection]);

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
      collection.avatarIds,
      tileSize.width + panMargin * 2,
      tileSize.height + panMargin * 2,
      {
        itemSize,
        edgePadding: 8,
        minGap: 24,
      },
    );
  }, [collection, itemSize, panMargin, tileSize]);

  const review = gloopie?.review;
  // Review takes over the surface whenever options exist, even if the user
  // came in from the collections level: the four options *are* the thing to
  // pick right now, so the canvas should not offer a competing job.
  const reviewOpen = Boolean(review) && !closing;
  // Same reasoning for the in-flight step: once generation starts on this
  // glass, the surface reports its own progress instead of dumping the user
  // back onto a canvas that no longer describes what they are waiting for.
  const generating = gloopie?.generating;
  const animating = gloopie?.animating;
  const generatingOpen = Boolean(generating) && !reviewOpen && !closing;
  const animatingOpen =
    Boolean(animating) && !reviewOpen && !generatingOpen && !closing;
  /** Any gloopie step that owns the whole surface. */
  const gloopieStepOpen = reviewOpen || generatingOpen || animatingOpen;
  // Generating and animating render the same "we're working, you can leave"
  // composition; only the body copy and which handlers own it differ.
  const waitingStep =
    generatingOpen && generating
      ? {
          body: t("gloopie.generatingBody"),
          onContinueSetup: generating.onContinueSetup,
          onDiscard: generating.onDiscard,
        }
      : animatingOpen && animating
        ? {
            body: t("gloopie.animatingBody"),
            onContinueSetup: animating.onContinueSetup,
            onDiscard: animating.onDiscard,
          }
        : null;

  /**
   * Confirmed "are you sure": run the destructive action the open dialog was
   * guarding. Both actions land the user back on the prompt step of this
   * surface — the attempt is gone but the description survives.
   */
  const onConfirmDestructive = useCallback(() => {
    setConfirmAction(null);
    if (confirmAction === "startOver") {
      review?.startOver();
      setCreateOpen(true);
      return;
    }
    if (confirmAction === "discard" && waitingStep) {
      waitingStep.onDiscard();
      setCreateOpen(true);
    }
  }, [confirmAction, review, waitingStep]);

  // Empty-canvas clicks (anything that is not a tile, the collections row,
  // or a chrome control) are handled in onCanvasClick: light-dismiss on the
  // collections level, release-the-highlight on collection pages.
  const panEnabled =
    Boolean(collection) && !createOpen && !gloopieStepOpen && !closing;

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
      if (closing) {
        return;
      }
      const target = event.target as HTMLElement;
      if (
        target.closest("button") ||
        target.closest("[data-collections-row]")
      ) {
        return;
      }
      // On the review step, clicking anywhere that is not an option or a
      // control releases the current highlight — the same "click off to
      // deselect" the collection pages have.
      if (reviewOpen && review) {
        review.chooseOption(null);
        return;
      }
      // While the backend is working there is nothing on this surface to
      // lose: clicking blank space means "let it finish in the background",
      // same as the primary button — funnel down to the rail's status card.
      if (waitingStep) {
        closeWithAnimation(waitingStep.onContinueSetup, "funnel");
        return;
      }
      // The prompt owns the whole surface; a stray canvas click there must
      // not dismiss the takeover and silently drop the user's text.
      if (createOpen || gloopieStepOpen) {
        return;
      }
      if (collection) {
        // On a collection page, clicking empty canvas releases the current
        // highlight — everything fades back up. Deliberately not a dismiss:
        // mis-clicking near an avatar must not throw the user out of the
        // picker.
        setPendingAvatarId(null);
        return;
      }
      // On the collections level, empty-canvas clicks light-dismiss the
      // overlay like a dialog scrim.
      closeWithAnimation(onClose);
    },
    [
      closing,
      closeWithAnimation,
      collection,
      createOpen,
      gloopieStepOpen,
      onClose,
      review,
      reviewOpen,
      waitingStep,
    ],
  );

  const onConfirmSelect = useCallback(() => {
    if (!pendingAvatarId || closing) {
      return;
    }
    const avatarId = pendingAvatarId;
    // The chosen avatar lands on the rail's preview; funnel toward it.
    closeWithAnimation(() => onSelectAvatar(avatarId), "funnel");
  }, [closing, closeWithAnimation, onSelectAvatar, pendingAvatarId]);

  const onCreateTile = useCallback(() => {
    if (!gloopie || closing) {
      return;
    }
    if (gloopie.hasActiveWork) {
      // In-flight generation: hand off to the rail's full creator, which owns
      // choosing/animating.
      closeWithAnimation(gloopie.onOpenActiveWork);
      return;
    }
    setCreateOpen(true);
  }, [closing, closeWithAnimation, gloopie]);

  const onAnimateChosen = useCallback(() => {
    if (!review || closing || !review.chosenOptionId) {
      return;
    }
    // Start the animation immediately so it runs during the exit, then land
    // back in the builder where the status card and toasts take over.
    review.animate();
    closeWithAnimation(review.onHandoff, "funnel");
  }, [closing, closeWithAnimation, review]);

  const onGenerate = useCallback(() => {
    if (!gloopie || closing || gloopie.object.trim().length === 0) {
      return;
    }
    gloopie.start();
    if (gloopie.stayOpenWhileGenerating) {
      // Keep the takeover up so progress and the resulting options land on
      // this glass. Picking an avatar is one job; it should not move surfaces
      // halfway through.
      return;
    }
    // Otherwise hand back to the builder rail, whose status card takes over.
    closeWithAnimation(gloopie.onHandoff, "funnel");
  }, [closing, closeWithAnimation, gloopie]);

  const hoverHandlers = useCallback(
    (id: string) => ({
      onPointerEnter: () => setHoveredAvatarId(id),
      onPointerLeave: () =>
        setHoveredAvatarId((current) => (current === id ? null : current)),
    }),
    [],
  );

  const renderAvatarItem = useCallback(
    (entry: AvatarCatalogEntry, item: ScatterItemLayout) => {
      const pending = pendingAvatarId === entry.id;
      // Highlighting an avatar fades everything else back instead of drawing
      // a ring; the highlighted one stays at full strength (and animates).
      const dimmed = pendingAvatarId !== null && !pending;
      const cachedMedia = getCachedAvatarMedia(
        library.cachedAvatarMediaById,
        catalogVersion,
        entry.id,
      );
      const downloading = library.downloadingCollectionIds.has(
        entry.collectionId,
      );
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
            cachedMedia && !readyIds.has(entry.id) && "avatar-scatter-waiting",
          )}
          style={scatterItemStyle(item)}
          ref={registerTileNode(entry.id)}
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
            aria-label={entry.label}
            aria-pressed={pending}
            disabled={!cachedMedia || closing}
            {...hoverHandlers(entry.id)}
            onClick={() =>
              setPendingAvatarId((current) =>
                current === entry.id ? null : entry.id,
              )
            }
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
                paused={hoveredAvatarId !== entry.id && !pending}
                className="avatar-scatter-media h-full w-full object-contain"
                onError={() => {}}
                onReady={() => markReady(entry.id)}
              />
            ) : downloading ? (
              <Spinner className="size-5 text-muted-foreground" />
            ) : (
              <span className="max-w-full truncate px-2 text-xs text-muted-foreground">
                {entry.label}
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
                disabled={closing}
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
      catalogVersion,
      closing,
      hoveredAvatarId,
      hoverHandlers,
      library.cachedAvatarMediaById,
      library.downloadingCollectionIds,
      markReady,
      onConfirmSelect,
      pendingAvatarId,
      readyIds,
      registerTileNode,
      t,
    ],
  );

  const renderCollectionRowItem = useCallback(
    (entry: AvatarCollection, index: number) => {
      const cover = getAvatarCatalogEntry(library.catalog, entry.coverAvatarId);
      const cachedMedia = cover
        ? getCachedAvatarMedia(
            library.cachedAvatarMediaById,
            catalogVersion,
            cover.id,
          )
        : undefined;
      return (
        <button
          key={entry.id}
          type="button"
          className={cn(
            "avatar-scatter-item group flex w-36 flex-col items-center gap-2 rounded-2xl p-2",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            cachedMedia && !readyIds.has(entry.id) && "avatar-scatter-waiting",
          )}
          style={rowItemStyle(index)}
          aria-label={t("collectionPage.openCollection", {
            label: entry.label,
          })}
          disabled={closing}
          {...hoverHandlers(entry.id)}
          onClick={() => setCollectionId(entry.id)}
        >
          <span className="flex h-28 w-full items-center justify-center">
            {cachedMedia ? (
              <AvatarMedia
                media={cachedMedia}
                alt=""
                lazy
                loadingStrategy="visible-video"
                paused={hoveredAvatarId !== entry.id}
                className="avatar-scatter-media max-h-full max-w-full object-contain"
                onError={() => {}}
                onReady={() => markReady(entry.id)}
              />
            ) : (
              <Spinner className="size-5 text-muted-foreground" />
            )}
          </span>
          <span className="shrink-0 text-sm text-foreground">
            {entry.label}
          </span>
        </button>
      );
    },
    [
      catalogVersion,
      closing,
      hoveredAvatarId,
      hoverHandlers,
      library.cachedAvatarMediaById,
      library.catalog,
      markReady,
      readyIds,
      t,
    ],
  );

  const renderCreateYourOwnRowItem = useCallback(
    (index: number) => {
      // Shadow silhouette of a real avatar instead of an icon — a character
      // you haven't met yet. Deliberately not any collection's cover, so the
      // silhouette never duplicates a tile sitting right next to it in the
      // row; prefer the first cached non-cover avatar.
      const coverIds = new Set(collections.map((entry) => entry.coverAvatarId));
      let silhouetteMedia: ReturnType<typeof getCachedAvatarMedia>;
      for (const entry of collections) {
        for (const avatarId of entry.avatarIds) {
          if (coverIds.has(avatarId)) {
            continue;
          }
          const cached = getCachedAvatarMedia(
            library.cachedAvatarMediaById,
            catalogVersion,
            avatarId,
          );
          if (cached) {
            silhouetteMedia = cached;
            break;
          }
        }
        if (silhouetteMedia) {
          break;
        }
      }
      const label = gloopie?.hasActiveWork
        ? t("gloopie.activeWorkAction")
        : t("editor.avatarCreateYourOwn");
      return (
        <button
          key="create-your-own"
          type="button"
          className={cn(
            "avatar-scatter-item group flex w-36 flex-col items-center gap-2 rounded-2xl p-2",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          style={rowItemStyle(index)}
          aria-label={label}
          disabled={closing}
          onClick={onCreateTile}
        >
          <span className="flex h-28 w-full items-center justify-center">
            {silhouetteMedia ? (
              <AvatarMedia
                media={silhouetteMedia}
                alt=""
                lazy
                loadingStrategy="visible-video"
                paused
                className="avatar-scatter-media max-h-full max-w-full object-contain opacity-60 brightness-0 dark:invert"
                onError={() => {}}
              />
            ) : (
              <IconWand className="size-8 text-foreground" aria-hidden="true" />
            )}
          </span>
          <span className="shrink-0 text-sm text-foreground">{label}</span>
        </button>
      );
    },
    [
      catalogVersion,
      closing,
      collections,
      gloopie?.hasActiveWork,
      library.cachedAvatarMediaById,
      onCreateTile,
      t,
    ],
  );

  const heading = reviewOpen
    ? t("gloopie.chooseTitle")
    : generatingOpen
      ? t("gloopie.generatingTitle")
      : animatingOpen
        ? t("gloopie.animatingTitle")
        : createOpen
          ? t("gloopie.title")
          : collection
            ? t("collectionPage.collectionHeading", {
                label: collection.label,
              })
            : t("collectionPage.collectionsHeading");

  const backLabel = reviewOpen
    ? t("gloopie.quitGeneration")
    : createOpen || (collection && hasCollectionsLevel)
      ? t("editor.avatarBackToCollections")
      : t("collectionPage.close");

  const collectionFailed = collection
    ? library.failedCollectionIds.has(collection.id)
    : library.error;

  const canGenerate = Boolean(gloopie && gloopie.object.trim().length > 0);

  return createPortal(
    // FocusScope gives this hand-rolled takeover the same focus containment
    // the shared Dialog gets from Radix: focus moves into the surface on
    // mount, Tab loops inside it, focus cannot escape to the still-mounted
    // chat/builder UI behind the portal, and it returns to the opener on
    // unmount. Radix maintains a scope stack, so the nested ConfirmDialog
    // pauses this trap while it is open.
    <FocusScope asChild loop trapped>
      <div
        className={cn(
          "fixed inset-0 z-[70] flex flex-col bg-[var(--overlay-avatar-field)] [backdrop-filter:var(--backdrop-avatar-field)] [-webkit-backdrop-filter:var(--backdrop-avatar-field)]",
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
          {tileSize && collection && !createOpen && !gloopieStepOpen ? (
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
                const entry = getAvatarCatalogEntry(library.catalog, item.id);
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
            avatar field (z-1) while the controls (z-2) float above it. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className="flex max-w-[85%] flex-col items-center gap-6"
              inert={closing ? true : undefined}
            >
              {reviewOpen && review ? (
                <>
                  <h1 className="avatar-collection-wordmark text-center text-6xl tracking-tight text-foreground/90 sm:text-7xl xl:text-8xl">
                    {heading}
                  </h1>
                  <p className="max-w-sm whitespace-pre-line text-center text-sm text-muted-foreground">
                    {t("gloopie.chooseHelp")}
                  </p>
                  <fieldset className="pointer-events-auto grid w-[min(72rem,80vw)] grid-cols-2 gap-3 sm:grid-cols-4">
                    <legend className="sr-only">
                      {t("gloopie.optionsGroupLabel")}
                    </legend>
                    {review.options.map((option, index) => (
                      <GloopieReviewTile
                        key={option.id}
                        avatarRef={option.avatarRef}
                        index={index}
                        total={review.options.length}
                        selected={review.chosenOptionId === option.id}
                        dimmed={
                          review.chosenOptionId !== null &&
                          review.chosenOptionId !== option.id
                        }
                        disabled={closing}
                        // Clicking the highlighted option again releases it,
                        // mirroring the collection tiles' toggle behavior.
                        onSelect={() =>
                          review.chooseOption(
                            review.chosenOptionId === option.id
                              ? null
                              : option.id,
                          )
                        }
                      />
                    ))}
                  </fieldset>
                  <div className="pointer-events-auto flex flex-col items-center gap-3">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={!review.chosenOptionId || closing}
                      onClick={onAnimateChosen}
                    >
                      {t("gloopie.useThisOne")}
                    </Button>
                    <div className="flex items-center gap-5">
                      <Button
                        type="button"
                        variant="ghost"
                        flush
                        leftIcon={<IconRefresh />}
                        disabled={closing}
                        onClick={review.regenerate}
                      >
                        {t("gloopie.regenerate")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        flush
                        disabled={closing}
                        onClick={goBack}
                      >
                        {backLabel}
                      </Button>
                    </div>
                  </div>
                </>
              ) : waitingStep ? (
                <>
                  <h1
                    className="avatar-collection-wordmark text-center text-6xl tracking-tight text-foreground/90 sm:text-7xl xl:text-8xl"
                    aria-live="polite"
                  >
                    {heading}
                  </h1>
                  <p className="max-w-sm whitespace-pre-line text-center text-sm text-muted-foreground">
                    {waitingStep.body}
                  </p>
                  <div className="pointer-events-auto flex flex-col items-center gap-3">
                    <Spinner
                      className="size-5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Button
                      type="button"
                      variant="primary"
                      disabled={closing}
                      onClick={() =>
                        closeWithAnimation(
                          waitingStep.onContinueSetup,
                          "funnel",
                        )
                      }
                    >
                      {t("gloopie.continueAgentSetup")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      flush
                      destructive
                      disabled={closing}
                      onClick={() => setConfirmAction("discard")}
                    >
                      {t("gloopie.cancelGeneration")}
                    </Button>
                  </div>
                </>
              ) : createOpen && gloopie ? (
                <>
                  {/* Same icon nav chrome as the collection levels: the arrow
                    above the wordmark goes up a level, instead of a one-off
                    text link beneath the primary action. */}
                  <div className="pointer-events-auto relative z-[2] flex items-center justify-center">
                    <GlassButton
                      type="button"
                      size="icon"
                      aria-label={backLabel}
                      disabled={closing}
                      onClick={goBack}
                    >
                      <IconArrowLeft aria-hidden="true" />
                    </GlassButton>
                  </div>
                  <h1 className="avatar-collection-wordmark text-center text-6xl tracking-tight text-foreground/90 sm:text-7xl xl:text-8xl">
                    {heading}
                  </h1>
                  <div className="pointer-events-auto flex w-80 flex-col items-stretch gap-3">
                    <p className="text-center text-sm text-muted-foreground">
                      {t("gloopie.promptHelp")}
                    </p>
                    {gloopie.errorMessage ? (
                      <p
                        role="alert"
                        className="text-center text-sm text-destructive"
                      >
                        {gloopie.errorMessage}
                      </p>
                    ) : null}
                    <Label
                      htmlFor="collection-gloopie-object"
                      className="sr-only"
                    >
                      {t("gloopie.promptLabel")}
                    </Label>
                    <Input
                      id="collection-gloopie-object"
                      autoFocus
                      value={gloopie.object}
                      maxLength={GLOOPIE_PROMPT_MAX_LENGTH}
                      placeholder={t("gloopie.promptPlaceholder")}
                      onChange={(event) =>
                        gloopie.setObject(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && canGenerate) {
                          event.preventDefault();
                          onGenerate();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="primary"
                      className="w-full"
                      disabled={!canGenerate || closing}
                      onClick={onGenerate}
                    >
                      {t("gloopie.generateAction")}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="pointer-events-auto relative z-[2] flex items-center justify-center gap-3">
                    <GlassButton
                      type="button"
                      size="icon"
                      aria-label={backLabel}
                      onClick={goBack}
                    >
                      {/* Arrow when the control navigates up a level; X when it
                        dismisses the overlay outright. */}
                      {collection && hasCollectionsLevel ? (
                        <IconArrowLeft aria-hidden="true" />
                      ) : (
                        <IconX aria-hidden="true" />
                      )}
                    </GlassButton>
                  </div>
                  <h1 className="avatar-collection-wordmark text-center text-6xl tracking-tight text-foreground/90 sm:text-7xl xl:text-8xl">
                    {heading}
                  </h1>
                  {!collection ? (
                    <div
                      data-collections-row
                      className="pointer-events-auto flex flex-wrap items-end justify-center gap-4 rounded-3xl p-6"
                    >
                      {collections.map((entry, index) =>
                        renderCollectionRowItem(entry, index),
                      )}
                      {gloopie
                        ? renderCreateYourOwnRowItem(collections.length)
                        : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {collectionFailed && !createOpen && !gloopieStepOpen ? (
            <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface-glass-strong px-4 py-2 text-sm text-surface-glass-strong-fg shadow-[var(--shadow-chat)] backdrop-blur-md">
              <span>
                {library.errorCode === "networkAccess"
                  ? t("editor.avatarCollectionNetworkAccess")
                  : t("avatar.loadFailed")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  if (collection) {
                    void library.openCollection(collection);
                  } else {
                    library.retryCatalog();
                  }
                }}
              >
                <RefreshCw className="size-3" aria-hidden="true" />
                {t("editor.avatarRetry")}
              </Button>
            </div>
          ) : null}
        </div>

        {/* "Are you sure" guarding the destructive gloopie actions. Rendered
          above the takeover (dialog layers are z-60/61 but portal later in
          the DOM, so they stack above this z-70 surface within their own
          stacking context — pass an explicit z to be safe). */}
        <ConfirmDialog
          open={confirmAction !== null}
          onOpenChange={(open) => {
            if (!open) {
              setConfirmAction(null);
            }
          }}
          title={
            confirmAction === "discard"
              ? t("gloopie.confirmCancelTitle")
              : t("gloopie.confirmStartOverTitle")
          }
          description={
            confirmAction === "discard"
              ? t("gloopie.confirmCancelBody")
              : t("gloopie.confirmStartOverBody")
          }
          cancelLabel={t("gloopie.confirmKeep")}
          confirmLabel={
            confirmAction === "discard"
              ? t("gloopie.confirmCancelAction")
              : t("gloopie.confirmStartOverAction")
          }
          overlayClassName="z-[80]"
          positionerClassName="z-[81]"
          onConfirm={onConfirmDestructive}
        />
      </div>
    </FocusScope>,
    document.body,
  );
}
