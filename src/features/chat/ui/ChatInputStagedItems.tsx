import { Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StagedItem } from "@/shared/types/messages";
import { ComposerChip } from "./ComposerChip";

export function ChatInputStagedItems({
  items,
  onRemove,
}: {
  items: readonly StagedItem[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  if (items.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <ComposerChip
          key={item.id}
          tone="quote"
          label={item.excerpt}
          title={item.excerpt}
          leading={<Quote />}
          onRemove={() => onRemove(item.id)}
          removeLabel={t("quotes.remove")}
        />
      ))}
    </div>
  );
}
