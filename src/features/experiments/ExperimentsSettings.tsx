import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EXPERIMENT_DEFINITIONS } from "./experimentDefinitions";
import { ExperimentConfigControls } from "./ExperimentConfigControls";
import {
  clearExperimentEnabledOverride,
  getVisibleExperimentRegistry,
  setExperimentEnabled,
  useExperimentList,
  type ExperimentRegistry,
} from "./experimentPreferences";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Switch } from "@/shared/ui/switch";

interface ExperimentsSettingsProps {
  registry?: ExperimentRegistry;
}

export function ExperimentsSettings({
  registry = EXPERIMENT_DEFINITIONS,
}: ExperimentsSettingsProps) {
  const { t } = useTranslation("settings");
  const visibleRegistry = useMemo(
    () => getVisibleExperimentRegistry(registry),
    [registry],
  );
  const experiments = useExperimentList(visibleRegistry);

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
          {import.meta.env.DEV ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("experiments.autoEnable.description")}
            </p>
          ) : null}
        </div>
        {visibleRegistry.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("experiments.emptyDescription")}
          </p>
        ) : (
          <div className="space-y-3">
            {visibleRegistry.map((definition) => {
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
                    <div className="flex shrink-0 items-center gap-2">
                      {experiment.enabledSource === "explicit" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const didSave = clearExperimentEnabledOverride(
                              definition.id,
                              registry,
                            );
                            if (!didSave) {
                              toast.error(t("experiments.saveError"));
                            }
                          }}
                          aria-label={t("experiments.resetToAuto")}
                        >
                          {t("experiments.resetToAuto")}
                        </Button>
                      ) : null}
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
