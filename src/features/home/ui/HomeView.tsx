import { Crosshair, LayoutGrid } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { prefetchProjectArtifactRenderer } from "@/features/projects/artifact/prefetchProjectArtifactRenderer";
import { OnboardingTourDialog } from "@/features/onboarding/ui/OnboardingTourDialog";
import { BERDY_ONBOARDING_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import type { SkillInfo } from "@/features/skills/api/skills";
import { TopBarIconButton } from "@/shared/ui/top-bar-icon-button";
import { clampLayoutCamera } from "../lib/layoutCamera";
import { getPinnedHomeChatSessionIds } from "../lib/pinnedHomeChats";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import {
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
} from "../widgets/catalog";
import { useInvalidateHomeWidgetSkillsOnChange } from "../widgets/skillQueryKey";
import type { WidgetInstance } from "../widgets/types";
import { WidgetCanvas } from "./WidgetCanvas";
import { useStarterTasks } from "@/features/home/onboarding/StarterTasksContext";
import {
  STARTER_PROJECT_ID,
  STARTER_TASKS_NOTE_ID,
} from "@/features/home/onboarding/starterTasks";

const RETIRED_EDUCATIONAL_STICKY_IDS = new Set([
  "onboarding:welcome",
  "onboarding:start-project",
  "onboarding:build-agent",
  "onboarding:reuse-workflows",
  "onboarding:manage-automations",
  "onboarding:shape-home",
]);

export interface HomeViewProps {
  onOpenProject?: (projectId: string) => void;
  onOpenSkill?: (skill: SkillInfo) => void;
  onOpenAgent?: (agentId: string) => void;
  onTagAgentInComposer?: (agentId: string) => void;
  onTagProjectInComposer?: (projectId: string) => void;
  onTagSkillInComposer?: (skill: SkillInfo) => void;
  onSelectSession?: (sessionId: string) => void;
  onStartProjectChat?: (projectId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  onOpenSkills?: () => void;
  onOpenAutomations?: () => void;
  onStartChatWithPrompt?: (
    prompt: string,
  ) => boolean | undefined | Promise<boolean | undefined>;
  onHydratePinnedChatSessions?: (sessionIds: string[]) => void;
  viewportLeftOcclusionPx?: number;
}

export function HomeView({
  onOpenProject,
  onOpenSkill,
  onOpenAgent,
  onTagAgentInComposer,
  onTagProjectInComposer,
  onTagSkillInComposer,
  onSelectSession,
  onStartProjectChat,
  onOpenAutomation,
  onCreatePersona,
  onCreateProject,
  onOpenSkills,
  onOpenAutomations,
  onStartChatWithPrompt,
  onHydratePinnedChatSessions,
  viewportLeftOcclusionPx = 0,
}: HomeViewProps) {
  const { t } = useTranslation("home");
  const starterTasks = useStarterTasks();
  const setTopBarActions = useSetTopBarActions();
  useInvalidateHomeWidgetSkillsOnChange();
  const [layoutMotionActive, setLayoutMotionActive] = useState(false);

  const [tourOpen, setTourOpen] = useState(false);
  const berdyOnboardingExperiment = useExperiment(
    BERDY_ONBOARDING_EXPERIMENT_ID,
  );
  const berdyOnboardingEnabled = Boolean(berdyOnboardingExperiment?.enabled);

  const {
    instances,
    loadStatus,
    error,
    retryInitialize,
    copyErrorDetails,
    widgetMutations,
    camera,
    constraints,
    saveCamera,
    cleanUpSnapshot,
    toggleCleanUpWidgets,
    syncOnboardingExperiment,
    reloadOnboardingTourForDev,
  } = useHomeWidgetLayoutController();

  const experimentVisibleInstances = useMemo(
    () =>
      berdyOnboardingEnabled
        ? instances
        : instances.filter((instance) => instance.type !== "onboardingTour"),
    [berdyOnboardingEnabled, instances],
  );
  const contentInstances = useMemo(
    () =>
      experimentVisibleInstances.filter((instance) => {
        if (
          !starterTasks?.visible &&
          instance.type === "onboardingProjectArtifact" &&
          instance.state?.projectId === STARTER_PROJECT_ID
        ) {
          return false;
        }
        return !RETIRED_EDUCATIONAL_STICKY_IDS.has(
          typeof instance.state?.noteId === "string"
            ? instance.state.noteId
            : "",
        );
      }),
    [experimentVisibleInstances, starterTasks?.visible],
  );
  useEffect(() => {
    if (
      loadStatus !== "ready" ||
      !starterTasks?.visible ||
      instances.some(
        (instance) => instance.state?.noteId === STARTER_TASKS_NOTE_ID,
      )
    ) {
      return;
    }
    widgetMutations.addWidget("stickyNote", -496, -142, {
      noteId: STARTER_TASKS_NOTE_ID,
    });
  }, [instances, loadStatus, starterTasks?.visible, widgetMutations]);

  useEffect(() => {
    if (loadStatus !== "ready" || !starterTasks?.visible) return;

    const existing = instances.find(
      (instance) =>
        instance.state?.onboardingStarterProject === true ||
        instance.state?.projectId === STARTER_PROJECT_ID,
    );
    const persistedProjectId =
      typeof existing?.state?.projectId === "string" &&
      existing.state.projectId !== STARTER_PROJECT_ID
        ? existing.state.projectId
        : null;
    const projectId =
      starterTasks.starterProjectId ?? persistedProjectId ?? STARTER_PROJECT_ID;
    if (existing) {
      if (existing.state?.projectId !== projectId) {
        widgetMutations.updateWidgetState(existing.id, {
          ...existing.state,
          projectId,
        });
      }
      if (
        existing.state?.projectId === STARTER_PROJECT_ID &&
        existing.width === 200 &&
        existing.height === 200
      ) {
        widgetMutations.resizeWidget(existing.id, 400, 400);
      }
      return;
    }
    widgetMutations.addWidget("onboardingProjectArtifact", 300, -60, {
      projectId,
      onboardingStarterProject: true,
    });
  }, [
    instances,
    loadStatus,
    starterTasks?.starterProjectId,
    starterTasks?.visible,
    widgetMutations,
  ]);

  const starterTaskInstance = useMemo<WidgetInstance | null>(() => {
    if (!starterTasks?.visible || starterTasks.docked) return null;
    if (
      contentInstances.some(
        (instance) => instance.state?.noteId === STARTER_TASKS_NOTE_ID,
      )
    ) {
      return null;
    }
    return {
      id: "onboarding-starter-tasks",
      type: "stickyNote",
      x: -624,
      y: -240,
      z: Math.max(0, ...contentInstances.map((instance) => instance.z)) + 1,
      width: 224,
      height: 196,
      state: { noteId: STARTER_TASKS_NOTE_ID },
    };
  }, [contentInstances, starterTasks?.docked, starterTasks?.visible]);
  const visibleInstances = useMemo(
    () =>
      starterTaskInstance
        ? [...contentInstances, starterTaskInstance]
        : contentInstances,
    [contentInstances, starterTaskInstance],
  );
  const recenterTarget = useMemo(
    () => widgetCenterOfGravity(visibleInstances),
    [visibleInstances],
  );
  const pinnedChatSessionIdKey = useMemo(() => {
    const ids = [...getPinnedHomeChatSessionIds(instances)].sort();

    return ids.join("\u001f");
  }, [instances]);
  const recenterTitle = t("widgets.canvasControls.recenterTitle");
  const recenterVisibleLabel = t("widgets.canvasControls.recenterVisibleLabel");
  const cleanUpTitle = t("widgets.canvasControls.cleanUpTitle");
  const restoreTitle = t("widgets.canvasControls.restoreTitle");
  const cleanUpControlTitle = cleanUpSnapshot ? restoreTitle : cleanUpTitle;
  const hasCleanableWidgets = recenterTarget !== null;

  useEffect(() => {
    void prefetchProjectArtifactRenderer();
  }, []);

  useEffect(() => {
    if (loadStatus === "ready") {
      syncOnboardingExperiment(berdyOnboardingEnabled);
    }
  }, [berdyOnboardingEnabled, loadStatus, syncOnboardingExperiment]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const handleReloadOnboarding = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        reloadOnboardingTourForDev();
      }
    };

    window.addEventListener("keydown", handleReloadOnboarding);
    return () => window.removeEventListener("keydown", handleReloadOnboarding);
  }, [reloadOnboardingTourForDev]);

  const handleStartTour = useCallback(() => {
    setTourOpen(true);
  }, []);

  const handleTourOpenChange = useCallback((open: boolean) => {
    setTourOpen(open);
  }, []);

  useEffect(() => {
    if (loadStatus !== "ready" || !onHydratePinnedChatSessions) {
      return;
    }

    const sessionIds = pinnedChatSessionIdKey
      ? pinnedChatSessionIdKey.split("\u001f")
      : [];

    if (sessionIds.length > 0) {
      onHydratePinnedChatSessions(sessionIds);
    }
  }, [loadStatus, onHydratePinnedChatSessions, pinnedChatSessionIdKey]);

  useEffect(() => {
    if (!layoutMotionActive) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLayoutMotionActive(false);
    }, 280);

    return () => window.clearTimeout(timer);
  }, [layoutMotionActive]);

  const handleRecenter = useCallback(() => {
    if (!camera || !recenterTarget) {
      return;
    }

    setLayoutMotionActive(true);
    const nextCamera = {
      centerX: recenterTarget.x,
      centerY: recenterTarget.y,
      zoomBps: camera.zoomBps,
    };
    saveCamera(
      constraints ? clampLayoutCamera(nextCamera, constraints) : nextCamera,
    );
  }, [camera, constraints, recenterTarget, saveCamera]);

  const handleCleanUp = useCallback(() => {
    setLayoutMotionActive(true);
    toggleCleanUpWidgets(constraints ?? undefined);
  }, [constraints, toggleCleanUpWidgets]);

  useEffect(() => {
    if (loadStatus !== "ready") {
      setTopBarActions(null);
      return;
    }

    setTopBarActions(
      <>
        <TopBarIconButton
          type="button"
          onClick={handleCleanUp}
          disabled={!hasCleanableWidgets}
          aria-label={cleanUpControlTitle}
          tooltip={cleanUpControlTitle}
        >
          <LayoutGrid aria-hidden="true" />
        </TopBarIconButton>
        <TopBarIconButton
          type="button"
          onClick={handleRecenter}
          disabled={!recenterTarget}
          aria-label={recenterTitle}
          tooltip={recenterTitle}
        >
          <Crosshair aria-hidden="true" />
        </TopBarIconButton>
      </>,
    );

    return () => setTopBarActions(null);
  }, [
    cleanUpControlTitle,
    handleCleanUp,
    handleRecenter,
    hasCleanableWidgets,
    loadStatus,
    recenterTarget,
    recenterTitle,
    setTopBarActions,
  ]);

  return (
    <div className="relative h-full w-full">
      {loadStatus === "ready" ? (
        <WidgetCanvas
          instances={visibleInstances}
          pickerInstances={instances}
          mutations={widgetMutations}
          animateCameraTransition={layoutMotionActive}
          onRecenter={handleRecenter}
          recenterTarget={recenterTarget}
          recenterLabel={recenterVisibleLabel}
          recenterTitle={recenterTitle}
          viewportLeftOcclusionPx={viewportLeftOcclusionPx}
          onOpenProject={onOpenProject}
          onOpenSkill={onOpenSkill}
          onOpenAgent={onOpenAgent}
          onTagAgentInComposer={onTagAgentInComposer}
          onTagProjectInComposer={onTagProjectInComposer}
          onTagSkillInComposer={onTagSkillInComposer}
          onSelectSession={onSelectSession}
          onStartProjectChat={onStartProjectChat}
          onOpenAutomation={onOpenAutomation}
          onCreatePersona={onCreatePersona}
          onCreateProject={onCreateProject}
          onOpenSkills={onOpenSkills}
          onOpenAutomations={onOpenAutomations}
          onStartOnboardingTour={handleStartTour}
          onStartChatWithPrompt={onStartChatWithPrompt}
        />
      ) : null}
      <OnboardingTourDialog
        open={berdyOnboardingEnabled && tourOpen}
        onOpenChange={handleTourOpenChange}
      />
      {loadStatus === "loading" ? (
        <div className="relative h-full w-full bg-dot-grid">
          <div className="absolute inset-x-0 top-8 flex justify-center text-sm text-muted-foreground">
            {t("widgetLayer.loading")}
          </div>
        </div>
      ) : null}
      {loadStatus === "error" ? (
        <div className="relative h-full w-full bg-dot-grid">
          <div className="absolute inset-x-0 top-8 flex justify-center px-4">
            <div className="flex max-w-[520px] flex-col items-center gap-3 text-center">
              <p className="text-sm font-medium text-foreground">
                {t("widgetLayer.error.title")}
              </p>
              {error ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {error}
                </p>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm hover:bg-muted"
                  onClick={() => void retryInitialize()}
                >
                  {t("widgetLayer.error.retry")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm hover:bg-muted"
                  onClick={() => void copyErrorDetails()}
                >
                  {t("widgetLayer.error.copyDetails")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function widgetCenterOfGravity(
  instances: WidgetInstance[],
): { x: number; y: number } | null {
  let count = 0;
  let totalX = 0;
  let totalY = 0;

  for (const instance of instances) {
    const catalogEntry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
    if (!catalogEntry?.Component) {
      continue;
    }

    const size = widgetSizeForInstance(instance);
    totalX += instance.x + size.width / 2;
    totalY += instance.y + size.height / 2;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  return {
    x: totalX / count,
    y: totalY / count,
  };
}

function useHomeWidgetLayoutController() {
  const instances = useHomeWidgetStore((state) => state.instances);
  const loadStatus = useHomeWidgetStore((state) => state.loadStatus);
  const error = useHomeWidgetStore((state) => state.error);
  const camera = useHomeWidgetStore((state) => state.camera);
  const constraints = useHomeWidgetStore((state) => state.constraints);
  const initialize = useHomeWidgetStore((state) => state.initialize);
  const retryInitialize = useHomeWidgetStore((state) => state.retryInitialize);
  const copyErrorDetails = useHomeWidgetStore(
    (state) => state.copyErrorDetails,
  );
  const saveCamera = useHomeWidgetStore((state) => state.saveCamera);
  const addWidget = useHomeWidgetStore((state) => state.addWidget);
  const moveWidget = useHomeWidgetStore((state) => state.moveWidget);
  const resizeWidget = useHomeWidgetStore((state) => state.resizeWidget);
  const bumpZ = useHomeWidgetStore((state) => state.bumpZ);
  const cleanUpSnapshot = useHomeWidgetStore((state) => state.cleanUpSnapshot);
  const toggleCleanUpWidgets = useHomeWidgetStore(
    (state) => state.toggleCleanUpWidgets,
  );
  const syncOnboardingExperiment = useHomeWidgetStore(
    (state) => state.syncOnboardingExperiment,
  );
  const reloadOnboardingTourForDev = useHomeWidgetStore(
    (state) => state.reloadOnboardingTourForDev,
  );
  const removeWidget = useHomeWidgetStore((state) => state.removeWidget);
  const updateWidgetState = useHomeWidgetStore(
    (state) => state.updateWidgetState,
  );

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const widgetMutations = useMemo(
    () => ({
      addWidget,
      moveWidget,
      resizeWidget,
      bumpZ,
      removeWidget,
      updateWidgetState,
    }),
    [
      addWidget,
      moveWidget,
      resizeWidget,
      bumpZ,
      removeWidget,
      updateWidgetState,
    ],
  );

  return {
    instances,
    loadStatus,
    error,
    retryInitialize,
    copyErrorDetails,
    widgetMutations,
    camera,
    constraints,
    saveCamera,
    cleanUpSnapshot,
    toggleCleanUpWidgets,
    syncOnboardingExperiment,
    reloadOnboardingTourForDev,
  };
}
