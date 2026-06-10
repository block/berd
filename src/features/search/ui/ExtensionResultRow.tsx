import {
  getDisplayName,
  type ExtensionEntry,
} from "@/features/extensions/types";
import { ResultRow } from "./ResultRow";

interface ExtensionResultRowProps {
  id?: string;
  entry: ExtensionEntry;
  stateLabel: string;
  ariaLabel: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (entry: ExtensionEntry) => void;
}

export function ExtensionResultRow({
  id,
  entry,
  stateLabel,
  ariaLabel,
  isActive,
  onActive,
  onSelect,
}: ExtensionResultRowProps) {
  const title = getDisplayName(entry);
  const description = entry.description?.trim();
  const meta = description ? `${stateLabel} · ${description}` : stateLabel;

  return (
    <ResultRow
      id={id}
      title={title}
      meta={meta}
      ariaLabel={ariaLabel}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(entry)}
    />
  );
}
