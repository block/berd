import { Quote } from "lucide-react";
import type { StagedItem } from "@/shared/types/messages";

export function MessageStagedQuotes({
  items,
}: {
  items: readonly StagedItem[];
}) {
  const quotes = items.filter((item) => item.kind === "quote");
  if (quotes.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {quotes.map((quote) => (
        <div
          key={quote.id}
          className="flex max-w-full items-start gap-2 rounded-xs bg-chip-chat-bg px-2.5 py-2 text-xs text-chip-chat-fg"
        >
          <Quote className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-3 whitespace-pre-wrap break-words">
            {quote.excerpt}
          </span>
        </div>
      ))}
    </div>
  );
}
