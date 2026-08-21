import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { IconQuote } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { Message, StagedQuoteItem } from "@/shared/types/messages";
import { JumpToLatestButton } from "@/shared/ui/jump-to-latest-button";
import {
  getQuoteAffordancePosition,
  stagedQuoteFromSelection,
} from "../lib/transcriptQuoteSelection";
import { useChatStore } from "../stores/chatStore";

interface PendingQuote {
  item: StagedQuoteItem;
  left: number;
  top: number;
}

export function TranscriptQuoteAffordance({
  messages,
  rootRef,
  sessionId,
}: {
  messages: readonly Message[];
  rootRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
}) {
  const { t } = useTranslation("chat");
  const [pendingQuote, setPendingQuote] = useState<PendingQuote | null>(null);
  const [announcementSequence, setAnnouncementSequence] = useState(0);
  // True while a pointer drag that started in the transcript is still in
  // progress. The affordance must not appear mid-selection; it shows once
  // the gesture releases.
  const isSelectingRef = useRef(false);

  const updateFromSelection = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || !sessionId || selection.rangeCount !== 1) {
      setPendingQuote(null);
      return;
    }
    const item = stagedQuoteFromSelection({ messages, root, selection });
    const position = item
      ? getQuoteAffordancePosition(selection.getRangeAt(0), root)
      : null;
    setPendingQuote(item && position ? { item, ...position } : null);
  }, [messages, rootRef, sessionId]);

  const updateUnlessSelecting = useCallback(() => {
    if (isSelectingRef.current) {
      setPendingQuote(null);
      return;
    }
    updateFromSelection();
  }, [updateFromSelection]);

  const stagePendingQuote = useCallback(() => {
    if (!sessionId || !pendingQuote) return;
    useChatStore.getState().setStagedItems(sessionId, [pendingQuote.item]);
    window.getSelection()?.removeAllRanges();
    setPendingQuote(null);
    setAnnouncementSequence((sequence) => sequence + 1);
  }, [pendingQuote, sessionId]);

  // The key on the affordance remounts it when the rendered session changes,
  // so pending selection state can never cross sessions.
  useEffect(() => {
    const root = rootRef.current;
    const handlePointerDown = () => {
      isSelectingRef.current = true;
      setPendingQuote(null);
    };
    // The pointer may release outside the transcript, so the gesture ends
    // on the document, not the root.
    const handlePointerEnd = () => {
      isSelectingRef.current = false;
      updateFromSelection();
    };
    const handleKeyboardContextMenu = (event: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (
        pendingQuote &&
        activeElement &&
        root?.contains(activeElement) &&
        (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      ) {
        event.preventDefault();
        stagePendingQuote();
      }
    };
    document.addEventListener("selectionchange", updateUnlessSelecting);
    window.addEventListener("resize", updateUnlessSelecting);
    document.addEventListener("pointerup", handlePointerEnd);
    document.addEventListener("pointercancel", handlePointerEnd);
    document.addEventListener("mouseup", handlePointerEnd);
    root?.addEventListener("pointerdown", handlePointerDown);
    root?.addEventListener("keyup", updateUnlessSelecting);
    document.addEventListener("keydown", handleKeyboardContextMenu);
    root?.addEventListener("scroll", updateUnlessSelecting);
    return () => {
      document.removeEventListener("selectionchange", updateUnlessSelecting);
      window.removeEventListener("resize", updateUnlessSelecting);
      document.removeEventListener("pointerup", handlePointerEnd);
      document.removeEventListener("pointercancel", handlePointerEnd);
      document.removeEventListener("mouseup", handlePointerEnd);
      root?.removeEventListener("pointerdown", handlePointerDown);
      root?.removeEventListener("keyup", updateUnlessSelecting);
      document.removeEventListener("keydown", handleKeyboardContextMenu);
      root?.removeEventListener("scroll", updateUnlessSelecting);
    };
  }, [
    pendingQuote,
    rootRef,
    stagePendingQuote,
    updateFromSelection,
    updateUnlessSelecting,
  ]);

  return (
    <>
      {announcementSequence > 0 ? (
        <div
          key={announcementSequence}
          className="sr-only"
          role="status"
          aria-live="polite"
        >
          {t("quotes.quoteAdded")}
        </div>
      ) : null}
      {pendingQuote && sessionId ? (
        <div
          className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full"
          style={{ left: pendingQuote.left, top: pendingQuote.top }}
        >
          <JumpToLatestButton
            type="button"
            size="xs"
            className="pointer-events-auto"
            leftIcon={<IconQuote />}
            onPointerDown={(event) => event.preventDefault()}
            onClick={stagePendingQuote}
          >
            {t("quotes.quoteInMessage")}
          </JumpToLatestButton>
        </div>
      ) : null}
    </>
  );
}
