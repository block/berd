import type { StagedItem } from "@/shared/types/messages";
import { StagedQuoteChip } from "./StagedQuoteChip";

export function ChatInputStagedItems({
  items,
  onRemove,
}: {
  items: readonly StagedItem[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <StagedQuoteChip
          key={item.id}
          quote={item}
          mode="draft"
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
