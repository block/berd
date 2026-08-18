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
  resetHomeForOnboardingExperience,
  resetOnboardingTourExperience,
  resetStarterTasksExperience,
  syncOnboardingExperimentState,
} from "@/features/onboarding/resetOnboardingTour";
import { Badge } from "@/shared/ui/badge";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { Switch } from "@/shared/ui/switch";
import { STARTER_TASKS_EXPERIMENT_ID } from "./experimentDefinitions";
import { resetAssistiveUxMoment } from "@/shared/assistive-ux/state";

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
  const [isResettingAllOnboarding, setIsResettingAllOnboarding] =
    useState(false);
  const [resetAllConfirmationOpen, setResetAllConfirmationOpen] =
    useState(false);
  const visibleRegistry = useMemo(
    () =>
      getVisibleExperimentRegistry(registry).filter(
        (definition) =>
          definition.settingsVisibility !== "dev" || import.meta.env.DEV,
      ),
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
        <SettingsRow
          labelId={titleId}
          descriptionId={descriptionId}
          label={
            <span className="flex min-w-0 items-center gap-1.5">
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
            </span>
          }
          description={t(definition.descriptionKey)}
          action={
            showExperimentToggle ||
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
                {definition.id === STARTER_TASKS_EXPERIMENT_ID ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("experiments.starterTasks.resetAria")}
                    onClick={() => {
                      void resetStarterTasksExperience().then((didReset) => {
                        if (!didReset) {
                          toast.error(
                            t("experiments.onboarding.resetAllError"),
                          );
                          return;
                        }
                        resetAssistiveUxMoment("home.starterTasks");
                        window.dispatchEvent(new Event("starter-tasks-reset"));
                        toast.success(
                          t("experiments.starterTasks.resetSuccess"),
                        );
                      });
                    }}
                  >
                    {t("experiments.starterTasks.reset")}
                  </Button>
                ) : null}
                {definition.id === BERDY_ONBOARDING_EXPERIMENT_ID ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
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
                          toast.error(
                            t("experiments.berdyOnboarding.resetError"),
                          );
                        }
                      } catch {
                        toast.error(
                          t("experiments.berdyOnboarding.resetError"),
                        );
                      } finally {
                        setIsResettingBerdyOnboarding(false);
                      }
                    }}
                  >
                    {t("experiments.berdyOnboarding.resetLabel")}
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
            ) : undefined
          }
        />
        <ExperimentConfigControls
          definition={definition}
          experiment={experiment}
          registry={registry}
          disabled={configDisabled ?? !experiment.enabled}
        />
      </div>
    );
  };

  const onboardingExperimentIds = new Set([
    STARTER_TASKS_EXPERIMENT_ID,
    BERDY_ONBOARDING_EXPERIMENT_ID,
  ]);
  const onboardingDefinitions = visibleRegistry.filter((definition) =>
    onboardingExperimentIds.has(definition.id),
  );
  const otherDefinitions = visibleRegistry.filter(
    (definition) => !onboardingExperimentIds.has(definition.id),
  );
  const renderExperimentCard = (definition: ExperimentDefinition) => (
    <section
      key={definition.id}
      className="border-b border-border last:border-b-0"
    >
      {renderExperimentControls(definition)}
    </section>
  );

  const handleResetAllOnboarding = async () => {
    setIsResettingAllOnboarding(true);
    const previousStarterTasks = getExperiment(
      STARTER_TASKS_EXPERIMENT_ID,
      registry,
    );
    const previousBerdy = getExperiment(
      BERDY_ONBOARDING_EXPERIMENT_ID,
      registry,
    );
    let resetSucceeded = false;
    try {
      const starterTasksEnabled = setExperimentEnabled(
        STARTER_TASKS_EXPERIMENT_ID,
        true,
        registry,
      );
      const berdyEnabled = setExperimentEnabled(
        BERDY_ONBOARDING_EXPERIMENT_ID,
        true,
        registry,
      );
      if (!starterTasksEnabled || !berdyEnabled) {
        throw new Error("Unable to enable onboarding experiments");
      }
      const resetResult = await resetHomeForOnboardingExperience();
      if (resetResult.itemsConfirmed) {
        resetAssistiveUxMoment("home.starterTasks");
        window.dispatchEvent(new Event("starter-tasks-state-reset"));
        setResetAllConfirmationOpen(false);
        resetSucceeded = true;
        if (resetResult.starterAgentsConfirmed === false) {
          toast.warning(t("experiments.onboarding.resetAllPartial"));
        } else if (resetResult.cameraConfirmed) {
          toast.success(t("experiments.onboarding.resetAllSuccess"));
        }
      } else {
        toast.error(t("experiments.onboarding.resetAllError"));
      }
    } catch {
      toast.error(t("experiments.onboarding.resetAllError"));
    } finally {
      if (!resetSucceeded) {
        if (previousStarterTasks?.enabledSource === "auto") {
          clearExperimentEnabledOverride(STARTER_TASKS_EXPERIMENT_ID, registry);
        } else if (previousStarterTasks) {
          setExperimentEnabled(
            STARTER_TASKS_EXPERIMENT_ID,
            previousStarterTasks.enabled,
            registry,
          );
        }
        if (previousBerdy?.enabledSource === "auto") {
          clearExperimentEnabledOverride(
            BERDY_ONBOARDING_EXPERIMENT_ID,
            registry,
          );
        } else if (previousBerdy) {
          setExperimentEnabled(
            BERDY_ONBOARDING_EXPERIMENT_ID,
            previousBerdy.enabled,
            registry,
          );
        }
      }
      setIsResettingAllOnboarding(false);
    }
  };

  return (
    <SettingsPage
      title={t("experiments.title")}
      description={
        <>
          {t("experiments.description")}
          {import.meta.env.DEV ? (
            <span className="mt-1 block">
              {t("experiments.autoEnable.description")}
            </span>
          ) : null}
        </>
      }
    >
      {visibleRegistry.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("experiments.emptyDescription")}
        </p>
      ) : (
        <SettingsSections>
          {otherDefinitions.length > 0 ? (
            <SettingsSection>
              {otherDefinitions.map(renderExperimentCard)}
            </SettingsSection>
          ) : null}
          {onboardingDefinitions.length > 0 ? (
            <SettingsSection
              title={t("experiments.onboarding.title")}
              titleId="onboarding-experiments-title"
            >
              <div className="flex items-end justify-between gap-4 pb-3">
                <p className="text-xs text-muted-foreground">
                  {t("experiments.onboarding.description")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isResettingAllOnboarding}
                  onClick={() => setResetAllConfirmationOpen(true)}
                >
                  {t("experiments.onboarding.resetAll")}
                </Button>
              </div>
              {onboardingDefinitions.map((definition) =>
                renderExperimentControls(definition),
              )}
            </SettingsSection>
          ) : null}
        </SettingsSections>
      )}
      <ConfirmDialog
        open={resetAllConfirmationOpen}
        onOpenChange={setResetAllConfirmationOpen}
        title={t("experiments.onboarding.confirmTitle")}
        description={t("experiments.onboarding.confirmDescription")}
        cancelLabel={t("experiments.onboarding.cancel")}
        confirmLabel={t("experiments.onboarding.confirm")}
        loadingLabel={t("experiments.onboarding.confirming")}
        isLoading={isResettingAllOnboarding}
        onConfirm={handleResetAllOnboarding}
      />
    </SettingsPage>
  );
}
