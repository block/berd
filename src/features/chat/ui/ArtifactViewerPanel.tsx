import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { ArtifactViewer } from "./ArtifactViewer";
import { isRemoteSession } from "../lib/remoteSession";
import { useChatSessionStore } from "../stores/chatSessionStore";
import {
  useArtifactViewerStore,
  useOpenArtifact,
  type OpenArtifact,
} from "../stores/artifactViewerStore";

const VIEWER_WIDTH_STORAGE_KEY = "goose:artifact-viewer-width";
const VIEWER_MIN_WIDTH = 420;
const VIEWER_MAX_WIDTH = 900;
const VIEWER_DEFAULT_WIDTH = 640;
// When the row runs out of space (right rail docked, narrow window), the
// viewer is the flex child that yields: it may render narrower than the
// user-chosen width, but never below this floor. Flexbox resolves the
// squeeze against the actual available row width. The cqw term (the chat
// row is a size container) scales the floor against the row itself, so
// sidebar occlusion is accounted for automatically on narrow windows.
const VIEWER_FLEX_MIN_WIDTH = "min(300px, 28cqw)";
// Floor for the conversation column while the viewer is open (applied in
// ChatView). Flexbox takes the squeeze out of the viewer first, down to
// VIEWER_FLEX_MIN_WIDTH; the conversation never drops below this.
export const CONVERSATION_MIN_WIDTH_WITH_VIEWER = "min(300px, 32cqw)";
// Extra viewport width the docked right rail must leave for the viewer.
// While the viewer is open, ChatView adds this to the context panel's
// compact-mode occlusion so the rail only docks when the row genuinely
// fits rail + viewer floor + conversation floor; below that the panel
// falls back to its existing compact overlay behavior instead of
// overflowing the row. 300px viewer floor + 12px gap.
export const ARTIFACT_VIEWER_RAIL_ALLOWANCE_PX = 312;

function clampWidth(width: number): number {
  return Math.min(Math.max(width, VIEWER_MIN_WIDTH), VIEWER_MAX_WIDTH);
}

function validateWidth(value: unknown, defaults: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clampWidth(value)
    : defaults;
}

interface ArtifactViewerPanelProps {
  sessionId: string;
}

/**
 * The wide, resizable file viewer that mounts between the conversation
 * column and the right rail. Because the conversation column is `flex-1`,
 * mounting this sibling naturally pushes it aside; enter/exit animates the
 * width so the conversation slides rather than snaps.
 *
 * Responsive behavior: once settled, the panel is a shrinkable flex child.
 * The user-chosen width acts as the preferred size, but when the row
 * tightens (right rail docked, narrow window) flexbox shrinks the panel
 * down to a floor instead of crushing the conversation column, which keeps
 * its own floor via CONVERSATION_MIN_WIDTH_WITH_VIEWER.
 */
export function ArtifactViewerPanel({ sessionId }: ArtifactViewerPanelProps) {
  const artifact = useOpenArtifact(sessionId);

  return (
    <AnimatePresence initial={false}>
      {artifact ? (
        <ViewerPanel
          key="artifact-viewer"
          sessionId={sessionId}
          artifact={artifact}
        />
      ) : null}
    </AnimatePresence>
  );
}

function ViewerPanel({
  sessionId,
  artifact,
}: {
  sessionId: string;
  artifact: OpenArtifact;
}) {
  const { t } = useTranslation("chat");
  const close = useArtifactViewerStore((s) => s.close);
  // A remote session's artifact paths live on its SSH host; the viewer then
  // renders a placeholder instead of statting/reading the local filesystem.
  const remoteHost = useChatSessionStore((s) => {
    const session = s.sessions.find((candidate) => candidate.id === sessionId);
    return isRemoteSession(session)
      ? (session?.remoteHost?.trim() ?? null)
      : null;
  });
  const reduceMotion = useReducedMotion();
  // False while AnimatePresence is exit-animating this panel. The min-width
  // floor must lift during enter/exit so the width can actually reach 0;
  // presence context keeps working after the parent freezes exit props.
  const isPresent = useIsPresent();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = usePersistedState(
    VIEWER_WIDTH_STORAGE_KEY,
    VIEWER_DEFAULT_WIDTH,
    validateWidth,
  );
  const [isResizing, setIsResizing] = useState(false);
  // Enter animation finished: hand layout back to flexbox (yielding), and
  // let the content fill the rendered width instead of holding the target.
  const [entered, setEntered] = useState(false);
  const settled = entered && isPresent;

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setIsResizing(true);
      const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
      // Drag from the rendered width (which may be flex-squeezed below the
      // stored preference), so the panel doesn't jump at drag start.
      const startWidth = panelRef.current?.offsetWidth ?? width;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : startX;
        // Dragging the left edge left widens the panel.
        setWidth(clampWidth(startWidth - (clientX - startX)));
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("blur", cleanup);
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("blur", cleanup);
    },
    [width, setWidth],
  );

  return (
    <motion.div
      ref={panelRef}
      data-artifact-viewer-panel
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-card"
      style={{
        maxWidth: VIEWER_MAX_WIDTH,
        minWidth: settled ? VIEWER_FLEX_MIN_WIDTH : 0,
      }}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      onAnimationComplete={() => setEntered(true)}
      transition={
        reduceMotion || isResizing
          ? { duration: 0 }
          : { duration: 0.2, ease: "easeOut" }
      }
    >
      {/* While sliding, hold the content at its target width so it glides
          into view instead of reflowing every frame. Once settled, let it
          fill the rendered width so flex squeezing reflows the content
          instead of clipping the panel's right edge. */}
      <div
        className="flex h-full min-h-0 flex-col"
        style={settled ? undefined : { width }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("artifactViewer.resize")}
              onPointerDown={startResize}
              className="absolute top-2 bottom-2 left-0 z-30 w-3 -translate-x-1/2 cursor-col-resize bg-transparent outline-none"
            />
          </TooltipTrigger>
          <TooltipContent>{t("artifactViewer.resize")}</TooltipContent>
        </Tooltip>
        <ArtifactViewer
          artifact={artifact}
          remoteHost={remoteHost}
          onClose={() => close(sessionId)}
        />
      </div>
    </motion.div>
  );
}
