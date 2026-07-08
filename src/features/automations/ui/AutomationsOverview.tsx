import { useTranslation } from "react-i18next";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import { automationTitle } from "@/features/automations/lib/automationFormatting";
import { AutomationOverviewRow } from "@/features/automations/ui/AutomationOverviewRow";

// Mirrors the gallery stagger used by the agents and skills pages so
// automations reveal with the same rhythm.
const GALLERY_CARD_STAGGER_MS = 55;

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
      {automations.map((tile, index) => {
        const key =
          tile.id ?? automationTitle(tile, t("fallbacks.untitledAutomation"));
        return (
          <div
            key={key}
            className="gallery-card-enter"
            style={{
              animationDelay: `${(index + 1) * GALLERY_CARD_STAGGER_MS}ms`,
            }}
          >
            <AutomationOverviewRow
              tile={tile}
              onOpenDetail={() => {
                if (tile.id) onOpenDetail(tile.id);
              }}
            />
          </div>
        );
      })}
    </section>
  );
}
