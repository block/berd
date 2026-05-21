import { useTranslation } from "react-i18next";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import { automationTitle } from "@/features/automations/lib/automationFormatting";
import { AutomationOverviewRow } from "@/features/automations/ui/AutomationOverviewRow";

export function AutomationsOverview({
  automations,
  onOpenDetail,
}: {
  automations: AutomationTile[];
  onOpenDetail: (automationId: string) => void;
}) {
  const { t } = useTranslation("automations");

  return (
    <section aria-label={t("overview.title")} className="space-y-2">
      {automations.map((tile) => {
        const key =
          tile.id ?? automationTitle(tile, t("fallbacks.untitledAutomation"));
        return (
          <AutomationOverviewRow
            key={key}
            tile={tile}
            onOpenDetail={() => {
              if (tile.id) onOpenDetail(tile.id);
            }}
          />
        );
      })}
    </section>
  );
}
