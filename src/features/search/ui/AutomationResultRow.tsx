import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import { automationTitle } from "@/features/automations/lib/automationFormatting";
import { ResultRow } from "./ResultRow";

interface AutomationResultRowProps {
  automation: AutomationTile;
  fallbackTitle: string;
  ariaLabel: string;
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
  automation,
  fallbackTitle,
  ariaLabel,
  onSelect,
}: AutomationResultRowProps) {
  const id = automation.id;
  if (!id) {
    return null;
  }
  return (
    <ResultRow
      title={automationTitle(automation, fallbackTitle)}
      meta={buildMeta(automation)}
      ariaLabel={ariaLabel}
      onClick={() => onSelect(id)}
    />
  );
}
