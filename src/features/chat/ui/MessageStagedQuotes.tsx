import type { StagedItem } from "@/shared/types/messages";
import { StagedQuoteChip } from "./StagedQuoteChip";

export function MessageStagedQuotes({
  items,
}: {
  items: readonly StagedItem[];
}) {
  const quotes = items.filter((item) => item.kind === "quote");
  if (quotes.length === 0) return null;

  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {quotes.map((quote) => (
        <StagedQuoteChip key={quote.id} quote={quote} mode="submitted" />
      ))}
    </div>
  );
}
