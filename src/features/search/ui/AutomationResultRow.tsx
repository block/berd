import { RefreshCw } from "lucide-react";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import { automationTitle } from "@/features/automations/lib/automationFormatting";
import { automationResultMeta } from "../lib/automationResultText";
import { ResultRow } from "./ResultRow";

interface AutomationResultRowProps {
  id?: string;
  automation: AutomationTile;
  fallbackTitle: string;
  ariaLabel: string;
  query?: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (automationId: string) => void;
}

export function AutomationResultRow({
  id: rowId,
  automation,
  fallbackTitle,
  ariaLabel,
  query,
  isActive,
  onActive,
  onSelect,
}: AutomationResultRowProps) {
  const id = automation.id;
  if (!id) {
    return null;
  }
  return (
    <ResultRow
      id={rowId}
      title={automationTitle(automation, fallbackTitle)}
      meta={automationResultMeta(automation)}
      icon={<RefreshCw aria-hidden="true" />}
      ariaLabel={ariaLabel}
      query={query}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(id)}
    />
  );
}
