import { IconQuote } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { StagedQuoteItem } from "@/shared/types/messages";
import {
  stagedQuoteLabel,
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
    count: quote.sources.length,
  });
  const wordCount = stagedQuoteWordCount(quote);
  const extent = t("quotes.extent.words", { count: wordCount });
  const preview = (
    <div className="max-w-80 space-y-1.5">
      <p className="text-xs text-popover-inverse-foreground/70">
        {source} · {extent}
      </p>
      <p className="whitespace-pre-wrap text-sm">“{quote.excerpt}”</p>
    </div>
  );

  return (
    <ComposerChip
      tone="quote"
      label={stagedQuoteLabel(quote)}
      title={preview}
      leading={<IconQuote className="size-3.5" />}
      onRemove={mode === "draft" ? () => onRemove?.(quote.id) : undefined}
      removeLabel={mode === "draft" ? t("quotes.remove") : undefined}
    />
  );
}
