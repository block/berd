import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import { automationTitle } from "@/features/automations/lib/automationFormatting";
import { ResultRow } from "./ResultRow";

interface AutomationResultRowProps {
  id?: string;
  automation: AutomationTile;
  fallbackTitle: string;
  ariaLabel: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (automationId: string) => void;
}

function buildMeta(automation: AutomationTile): string {
  if (automation.humanReadableInstructions?.length) {
    return automation.humanReadableInstructions.join(" ");
  }
  if (automation.instructions?.length) {
    return automation.instructions.join(" ");
  }
  return automation.schedule ?? "";
}

export function AutomationResultRow({
  id: rowId,
  automation,
  fallbackTitle,
  ariaLabel,
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
      meta={buildMeta(automation)}
      ariaLabel={ariaLabel}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(id)}
    />
  );
}
