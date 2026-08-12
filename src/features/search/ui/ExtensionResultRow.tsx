import { Plug } from "lucide-react";
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
  query?: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (entry: ExtensionEntry) => void;
}

export function ExtensionResultRow({
  id,
  entry,
  stateLabel,
  ariaLabel,
  query,
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
      icon={<Plug aria-hidden="true" />}
      ariaLabel={ariaLabel}
      query={query}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(entry)}
    />
  );
}
