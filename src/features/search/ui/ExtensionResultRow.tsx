import {
  getDisplayName,
  type ExtensionEntry,
} from "@/features/extensions/types";
import { ResultRow } from "./ResultRow";

interface ExtensionResultRowProps {
  entry: ExtensionEntry;
  stateLabel: string;
  ariaLabel: string;
  onSelect: (entry: ExtensionEntry) => void;
}

export function ExtensionResultRow({
  entry,
  stateLabel,
  ariaLabel,
  onSelect,
}: ExtensionResultRowProps) {
  const title = getDisplayName(entry);
  const description = entry.description?.trim();
  const meta = description ? `${stateLabel} · ${description}` : stateLabel;

  return (
    <ResultRow
      title={title}
      meta={meta}
      ariaLabel={ariaLabel}
      onClick={() => onSelect(entry)}
    />
  );
}
