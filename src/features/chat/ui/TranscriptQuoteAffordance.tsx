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
    document.addEventListener("selectionchange", updateUnlessSelecting);
    window.addEventListener("resize", updateUnlessSelecting);
    document.addEventListener("pointerup", handlePointerEnd);
    document.addEventListener("pointercancel", handlePointerEnd);
    root?.addEventListener("pointerdown", handlePointerDown);
    root?.addEventListener("keyup", updateUnlessSelecting);
    root?.addEventListener("scroll", updateUnlessSelecting);
    return () => {
      document.removeEventListener("selectionchange", updateUnlessSelecting);
      window.removeEventListener("resize", updateUnlessSelecting);
      document.removeEventListener("pointerup", handlePointerEnd);
      document.removeEventListener("pointercancel", handlePointerEnd);
      root?.removeEventListener("pointerdown", handlePointerDown);
      root?.removeEventListener("keyup", updateUnlessSelecting);
      root?.removeEventListener("scroll", updateUnlessSelecting);
    };
  }, [rootRef, updateFromSelection, updateUnlessSelecting]);

  if (!pendingQuote || !sessionId) return null;

  return (
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
        onClick={() => {
          const root = rootRef.current;
          const selection = window.getSelection();
          const currentItem =
            root && selection
              ? stagedQuoteFromSelection({ messages, root, selection })
              : null;
          if (!currentItem) {
            setPendingQuote(null);
            return;
          }
          // Version 1 sends one quote per message. The store model remains an
          // array so later slices can lift this presentation limit safely.
          useChatStore.getState().setStagedItems(sessionId, [currentItem]);
          window.getSelection()?.removeAllRanges();
          setPendingQuote(null);
        }}
      >
        {t("quotes.quoteInMessage")}
      </JumpToLatestButton>
    </div>
  );
}
