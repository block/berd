import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  EXPERIMENT_DEFINITIONS,
  NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
  NAVIGATION_REFRESH_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
  type ExperimentDefinition,
} from "./experimentDefinitions";
import { ExperimentConfigControls } from "./ExperimentConfigControls";
import {
  clearExperimentEnabledOverride,
  getVisibleExperimentRegistry,
  setExperimentConfigValue,
  setExperimentEnabled,
  useExperimentList,
  type ExperimentRegistry,
} from "./experimentPreferences";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
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
}

const NAVIGATION_EXPERIMENT_IDS = new Set([
  NAVIGATION_REFRESH_EXPERIMENT_ID,
  NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
]);

function isNavigationExperiment(definition: ExperimentDefinition) {
  return NAVIGATION_EXPERIMENT_IDS.has(definition.id);
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
  const experimentsById = useMemo(
    () => new Map(experiments.map((experiment) => [experiment.id, experiment])),
    [experiments],
  );
  const navigationExperimentDefinitions = useMemo(
    () => visibleRegistry.filter(isNavigationExperiment),
    [visibleRegistry],
  );
  const isNavigationRefreshEnabled = Boolean(
    experimentsById.get(NAVIGATION_REFRESH_EXPERIMENT_ID)?.enabled,
  );
  const sidebarFlatChatListExperiment = experimentsById.get(
    SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  );

  useEffect(() => {
    if (!isNavigationRefreshEnabled || !sidebarFlatChatListExperiment) {
      return;
    }

    if (sidebarFlatChatListExperiment.enabled) {
      setExperimentEnabled(
        SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
        false,
        registry,
      );
    }

    if (
      sidebarFlatChatListExperiment.config[
        SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY
      ] !== false
    ) {
      setExperimentConfigValue(
        SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
        SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
        false,
        registry,
      );
    }
  }, [isNavigationRefreshEnabled, registry, sidebarFlatChatListExperiment]);

  const handleExperimentEnabledChange = (
    definition: ExperimentDefinition,
    enabled: boolean,
  ) => {
    const didSave =
      definition.id === NAVIGATION_REFRESH_EXPERIMENT_ID
        ? enabled
          ? [
              setExperimentEnabled(
                SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
                false,
                registry,
              ),
              setExperimentConfigValue(
                SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
                SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
                false,
                registry,
              ),
              setExperimentEnabled(
                NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
                true,
                registry,
              ),
              setExperimentEnabled(definition.id, true, registry),
            ].every(Boolean)
          : [
              setExperimentEnabled(definition.id, false, registry),
              setExperimentEnabled(
                NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
                false,
                registry,
              ),
              setExperimentEnabled(
                SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
                true,
                registry,
              ),
            ].every(Boolean)
        : definition.id === SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID &&
            enabled &&
            isNavigationRefreshEnabled
          ? [
              setExperimentEnabled(
                NAVIGATION_REFRESH_EXPERIMENT_ID,
                false,
                registry,
              ),
              setExperimentEnabled(
                NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
                false,
                registry,
              ),
              setExperimentEnabled(definition.id, enabled, registry),
            ].every(Boolean)
          : definition.id === SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID && !enabled
            ? [
                setExperimentEnabled(definition.id, false, registry),
                setExperimentConfigValue(
                  SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
                  SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
                  false,
                  registry,
                ),
                setExperimentEnabled(
                  NAVIGATION_REFRESH_EXPERIMENT_ID,
                  true,
                  registry,
                ),
                setExperimentEnabled(
                  NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
                  true,
                  registry,
                ),
              ].every(Boolean)
            : setExperimentEnabled(definition.id, enabled, registry);

    if (!didSave) {
      toast.error(t("experiments.saveError"));
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

  const renderExperimentSubsectionToggle = (
    definition: ExperimentDefinition,
    { disabled = false }: { disabled?: boolean } = {},
  ) => {
    const experiment = experimentsById.get(definition.id);
    if (!experiment) return null;

    const titleId = `experiment-${definition.id}-title`;
    const descriptionId = `experiment-${definition.id}-description`;
    const controlId = `experiment-${definition.id}-toggle`;

    return (
      <div key={definition.id} className="bg-muted/20">
        <div className="relative flex items-center justify-between gap-6 py-3 pl-8 pr-4 before:absolute before:top-0 before:right-4 before:left-4 before:border-t before:content-['']">
          <div className="min-w-0 flex-1">
            <Label
              id={titleId}
              htmlFor={controlId}
              className="text-xs text-muted-foreground"
            >
              {t(definition.titleKey)}
            </Label>
            <p
              id={descriptionId}
              className="mt-1 text-xs text-muted-foreground"
            >
              {t(definition.descriptionKey)}
            </p>
          </div>
          <div className="flex shrink-0 justify-end">
            <Switch
              id={controlId}
              checked={experiment.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => {
                handleExperimentEnabledChange(definition, enabled);
              }}
              aria-labelledby={titleId}
              aria-describedby={descriptionId}
            />
          </div>
        </div>
      </div>
    );
  };

  const navigationRefreshDefinition = navigationExperimentDefinitions.find(
    (definition) => definition.id === NAVIGATION_REFRESH_EXPERIMENT_ID,
  );
  const navigationChatsUnderProjectsDefinition =
    navigationExperimentDefinitions.find(
      (definition) =>
        definition.id === NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
    );
  const sidebarFlatChatListDefinition = navigationExperimentDefinitions.find(
    (definition) => definition.id === SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  );

  let didRenderNavigationSection = false;
  const experimentCards = visibleRegistry.map((definition) => {
    if (isNavigationExperiment(definition)) {
      if (didRenderNavigationSection) return null;
      didRenderNavigationSection = true;

      return (
        <section
          key="navigation-experiments"
          aria-labelledby="navigation-experiments-title"
          className="overflow-hidden rounded-md border bg-background"
        >
          <div className="px-4 py-4">
            <h4
              id="navigation-experiments-title"
              className="text-sm font-medium text-foreground"
            >
              {t("experiments.navigationExperiments.title")}
            </h4>
          </div>
          {navigationRefreshDefinition
            ? renderExperimentControls(
                navigationRefreshDefinition,
                "relative before:absolute before:top-0 before:right-4 before:left-4 before:border-t before:content-['']",
                { showResetToAuto: false },
              )
            : null}
          {navigationChatsUnderProjectsDefinition
            ? renderExperimentSubsectionToggle(
                navigationChatsUnderProjectsDefinition,
                { disabled: !isNavigationRefreshEnabled },
              )
            : null}
          {sidebarFlatChatListDefinition
            ? renderExperimentControls(
                sidebarFlatChatListDefinition,
                "relative before:absolute before:top-0 before:right-4 before:left-4 before:border-t before:content-['']",
                {
                  configDisabled: isNavigationRefreshEnabled ? true : undefined,
                  showDefaultLabel: true,
                  showResetToAuto: false,
                },
              )
            : null}
        </section>
      );
    }

    return renderExperimentCard(definition);
  });

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
