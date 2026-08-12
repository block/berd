import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";

export function automationResultMeta(automation: AutomationTile): string {
  if (automation.humanReadableInstructions?.length) {
    return automation.humanReadableInstructions.join(" ");
  }
  if (automation.instructions?.length) {
    return automation.instructions.join(" ");
  }
  return automation.schedule ?? "";
}
