import { IconQuote } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { StagedQuoteItem } from "@/shared/types/messages";
import {
  stagedQuoteLabel,
  stagedQuoteMessageCount,
  stagedQuoteSourceKind,
  stagedQuoteWordCount,
} from "../lib/stagedItemPresentation";
import { ComposerChip } from "./ComposerChip";

export function StagedQuoteChip({
  quote,
  mode,
  onRemove,
}: {
  quote: StagedQuoteItem;
  mode: "draft" | "submitted";
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  const sourceKind = stagedQuoteSourceKind(quote);
  const source = t(`quotes.source.${sourceKind}`, {
    count: stagedQuoteMessageCount(quote),
  });
  const wordCount = stagedQuoteWordCount(quote);
  const extent = t("quotes.extent.words", { count: wordCount });
  // One preview surface: hover opens it, the header pins the provenance,
  // and the excerpt scrolls when the passage is long.
  const details = (
    <div className="flex max-h-80 flex-col">
      <p className="shrink-0 border-b border-popover-inverse-foreground/15 px-3 py-2 text-xs text-popover-inverse-foreground/70">
        {source} · {extent}
      </p>
      <div className="min-h-0 overflow-y-auto px-3 py-2.5">
        <p className="whitespace-pre-wrap text-sm">“{quote.excerpt}”</p>
      </div>
    </div>
  );

  return (
    <ComposerChip
      tone="quote"
      label={stagedQuoteLabel(quote)}
      details={details}
      leading={<IconQuote className="size-3.5" />}
      onRemove={mode === "draft" ? () => onRemove?.(quote.id) : undefined}
      removeLabel={mode === "draft" ? t("quotes.remove") : undefined}
    />
  );
}
