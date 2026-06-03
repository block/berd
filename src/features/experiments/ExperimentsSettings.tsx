import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EXPERIMENT_DEFINITIONS } from "./experimentDefinitions";
import { ExperimentConfigControls } from "./ExperimentConfigControls";
import {
  setExperimentEnabled,
  useExperimentList,
  type ExperimentRegistry,
} from "./experimentPreferences";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Switch } from "@/shared/ui/switch";

interface ExperimentsSettingsProps {
  registry?: ExperimentRegistry;
}

export function ExperimentsSettings({
  registry = EXPERIMENT_DEFINITIONS,
}: ExperimentsSettingsProps) {
  const { t } = useTranslation("settings");
  const experiments = useExperimentList(registry);

  return (
    <SettingsPage contentClassName="space-y-3">
      <section>
        <div className="mb-3">
          <h4 className="text-base text-foreground">
            {t("experiments.title")}
          </h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("experiments.description")}
          </p>
        </div>
        {registry.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("experiments.emptyDescription")}
          </p>
        ) : (
          <div className="space-y-3">
            {registry.map((definition) => {
              const experiment = experiments.find(
                (item) => item.id === definition.id,
              );
              if (!experiment) return null;

              const titleId = `experiment-${definition.id}-title`;
              const descriptionId = `experiment-${definition.id}-description`;

              return (
                <section
                  key={definition.id}
                  className="overflow-hidden rounded-md border bg-background"
                >
                  <div className="flex items-center justify-between gap-8 px-4 py-4">
                    <div className="min-w-0 flex-1">
                      <h4 id={titleId} className="text-sm font-medium">
                        {t(definition.titleKey)}
                      </h4>
                      <p
                        id={descriptionId}
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        {t(definition.descriptionKey)}
                      </p>
                    </div>
                    <Switch
                      checked={experiment.enabled}
                      onCheckedChange={(enabled) => {
                        const didSave = setExperimentEnabled(
                          definition.id,
                          enabled,
                          registry,
                        );
                        if (!didSave) {
                          toast.error(t("experiments.saveError"));
                        }
                      }}
                      aria-labelledby={titleId}
                      aria-describedby={descriptionId}
                    />
                  </div>
                  <ExperimentConfigControls
                    definition={definition}
                    experiment={experiment}
                    registry={registry}
                    disabled={!experiment.enabled}
                  />
                </section>
              );
            })}
          </div>
        )}
      </section>
    </SettingsPage>
  );
}
