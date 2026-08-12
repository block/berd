import { Settings } from "lucide-react";

import type { SectionId } from "@/features/settings/ui/settingsSections";
import { ResultRow } from "./ResultRow";

interface SettingsResultRowProps {
  id: string;
  sectionId: SectionId;
  title: string;
  meta: string;
  ariaLabel: string;
  query?: string;
  isActive: boolean;
  onActive: () => void;
  onSelect: (sectionId: SectionId) => void;
}

export function SettingsResultRow({
  id,
  sectionId,
  title,
  meta,
  ariaLabel,
  query,
  isActive,
  onActive,
  onSelect,
}: SettingsResultRowProps) {
  return (
    <ResultRow
      id={id}
      title={title}
      meta={meta}
      icon={<Settings aria-hidden="true" />}
      ariaLabel={ariaLabel}
      query={query}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(sectionId)}
    />
  );
}
