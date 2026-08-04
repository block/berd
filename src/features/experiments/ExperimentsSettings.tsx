import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  BERDY_ONBOARDING_EXPERIMENT_ID,
  EXPERIMENT_DEFINITIONS,
  type ExperimentDefinition,
} from "./experimentDefinitions";
import { ExperimentConfigControls } from "./ExperimentConfigControls";
import {
  clearExperimentEnabledOverride,
  getExperiment,
  getVisibleExperimentRegistry,
  setExperimentEnabled,
  useExperimentList,
  type ExperimentRegistry,
} from "./experimentPreferences";
import {
  resetOnboardingTourExperience,
  syncOnboardingExperimentState,
} from "@/features/onboarding/resetOnboardingTour";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Switch } from "@/shared/ui/switch";

interface ExperimentsSettingsProps {
  registry?: ExperimentRegistry;
}

interface RenderExperimentControlsOptions {
  configDisabled?: boolean;
  showDefaultLabel?: boolean;
  showExperimentToggle?: boolean;
  showResetToAuto?: boolean;
  toggleDisabled?: boolean;
}

export function ExperimentsSettings({
  registry = EXPERIMENT_DEFINITIONS,
}: ExperimentsSettingsProps) {
  const { t } = useTranslation("settings");
  const [isResettingBerdyOnboarding, setIsResettingBerdyOnboarding] =
    useState(false);
  const visibleRegistry = useMemo(
    () => getVisibleExperimentRegistry(registry),
    [registry],
  );
  const experiments = useExperimentList(visibleRegistry);
  const experimentsById = useMemo(
    () => new Map(experiments.map((experiment) => [experiment.id, experiment])),
    [experiments],
  );
  const handleExperimentEnabledChange = (
    definition: ExperimentDefinition,
    enabled: boolean,
  ) => {
    const didSave = setExperimentEnabled(definition.id, enabled, registry);

    if (!didSave) {
      toast.error(t("experiments.saveError"));
      return;
    }

    if (definition.id === BERDY_ONBOARDING_EXPERIMENT_ID) {
      void syncOnboardingExperimentState(enabled);
    }
  };

  const renderExperimentControls = (
    definition: ExperimentDefinition,
    rowClassName = "",
    {
      configDisabled,
      showDefaultLabel = false,
      showExperimentToggle = true,
      showResetToAuto = true,
      toggleDisabled = false,
    }: RenderExperimentControlsOptions = {},
  ) => {
    const experiment = experimentsById.get(definition.id);
    if (!experiment) return null;

    const titleId = `experiment-${definition.id}-title`;
    const descriptionId = `experiment-${definition.id}-description`;

    return (
      <div key={definition.id} className={rowClassName}>
        <div className="flex items-center justify-between gap-8 px-4 py-4">
          <div className="min-w-0 flex-1">
            <h4
              id={titleId}
              className="flex min-w-0 items-center gap-1.5 text-sm font-normal"
            >
              <span className="min-w-0 truncate">{t(definition.titleKey)}</span>
              {showDefaultLabel ? (
                <Badge
                  variant="secondary"
                  className="h-5 px-1.5 text-[11px] font-normal"
                  aria-hidden="true"
                >
                  {t("experiments.defaultLabel")}
                </Badge>
              ) : null}
            </h4>
            <p
              id={descriptionId}
              className="mt-1 text-xs text-muted-foreground"
            >
              {t(definition.descriptionKey)}
            </p>
          </div>
          {showExperimentToggle ||
          (showResetToAuto && experiment.enabledSource === "explicit") ? (
            <div className="flex shrink-0 items-center gap-2">
              {showResetToAuto && experiment.enabledSource === "explicit" ? (
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
                      return;
                    }
                    if (definition.id === BERDY_ONBOARDING_EXPERIMENT_ID) {
                      const enabled =
                        getExperiment(definition.id, registry)?.enabled ===
                        true;
                      void syncOnboardingExperimentState(enabled);
                    }
                  }}
                  aria-label={t("experiments.resetToAuto")}
                >
                  {t("experiments.resetToAuto")}
                </Button>
              ) : null}
              {showExperimentToggle ? (
                <Switch
                  checked={experiment.enabled}
                  disabled={toggleDisabled}
                  onCheckedChange={(enabled) => {
                    handleExperimentEnabledChange(definition, enabled);
                  }}
                  aria-labelledby={titleId}
                  aria-describedby={descriptionId}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <ExperimentConfigControls
          definition={definition}
          experiment={experiment}
          registry={registry}
          disabled={configDisabled ?? !experiment.enabled}
        />
        {definition.id === BERDY_ONBOARDING_EXPERIMENT_ID ? (
          <div className="flex items-center justify-between gap-8 border-t px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {t("experiments.berdyOnboarding.resetDescription")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={!experiment.enabled || isResettingBerdyOnboarding}
              onClick={async () => {
                setIsResettingBerdyOnboarding(true);
                try {
                  const didReset = await resetOnboardingTourExperience();
                  if (didReset) {
                    toast.success(
                      t("experiments.berdyOnboarding.resetSuccess"),
                    );
                  } else {
                    toast.error(t("experiments.berdyOnboarding.resetError"));
                  }
                } catch {
                  toast.error(t("experiments.berdyOnboarding.resetError"));
                } finally {
                  setIsResettingBerdyOnboarding(false);
                }
              }}
            >
              {t("experiments.berdyOnboarding.resetLabel")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderExperimentCard = (definition: ExperimentDefinition) => (
    <section
      key={definition.id}
      className="overflow-hidden rounded-md border bg-background"
    >
      {renderExperimentControls(definition)}
    </section>
  );

  const experimentCards = visibleRegistry.map(renderExperimentCard);

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
          <div className="space-y-3">{experimentCards}</div>
        )}
      </section>
    </SettingsPage>
  );
}
