import { useCallback, useEffect, useState, type RefObject } from "react";
import { Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Message, StagedQuoteItem } from "@/shared/types/messages";
import { GlassButton } from "@/shared/ui/glass-button";
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

  useEffect(() => {
    setPendingQuote(null);
  }, [sessionId]);

  useEffect(() => {
    const root = rootRef.current;
    document.addEventListener("selectionchange", updateFromSelection);
    window.addEventListener("resize", updateFromSelection);
    root?.addEventListener("scroll", updateFromSelection);
    return () => {
      document.removeEventListener("selectionchange", updateFromSelection);
      window.removeEventListener("resize", updateFromSelection);
      root?.removeEventListener("scroll", updateFromSelection);
    };
  }, [rootRef, updateFromSelection]);

  if (!pendingQuote || !sessionId) return null;

  return (
    <div
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full"
      style={{ left: pendingQuote.left, top: pendingQuote.top }}
    >
      <GlassButton
        type="button"
        size="xs"
        className="pointer-events-auto"
        leftIcon={<Quote />}
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
        {t("quotes.addToComposer")}
      </GlassButton>
    </div>
  );
}
