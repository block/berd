import { Crosshair, LayoutGrid } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { prefetchProjectArtifactRenderer } from "@/features/projects/artifact/prefetchProjectArtifactRenderer";
import { OnboardingTourDialog } from "@/features/onboarding/ui/OnboardingTourDialog";
import { BERDY_ONBOARDING_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import type { SkillInfo } from "@/features/skills/api/skills";
import { TopBarIconButton } from "@/shared/ui/top-bar-icon-button";
import {
  recordHomeItemPinIntent,
  recordHomeItemUnpinIntent,
} from "../lib/homePinTelemetry";
import { entityPinTargetFromWidget } from "../lib/homePinTargets";
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
  HOME_CAMERA_SAVE_CONFIRMED_EVENT,
  HOME_CAMERA_SAVE_DISCARDED_EVENT,
  HOME_WIDGET_SAVE_CONFIRMED_EVENT,
  HOME_WIDGET_SAVE_DISCARDED_EVENT,
} from "@/features/home/onboarding/homeWidgetSaveLifecycle";
import {
  areStarterAgentPinsEligible,
  haveStarterAgentPinsBeenSeeded,
  markStarterAgentPinsSeeded,
  selectStarterAgentPersonas,
} from "@/features/home/onboarding/starterAgents";
import {
  STARTER_PROJECT_ID,
  STARTER_TASKS_NOTE_ID,
} from "@/features/home/onboarding/starterTasks";
import {
  clearStarterHomeLayoutEligibility,
  getStarterTasksHeight,
  hasArrangedStarterHome,
  isStarterHomeLayoutEligible,
  markStarterHomeArranged,
  starterLayoutCenter,
  STARTER_HOME_LAYOUT,
} from "@/features/home/onboarding/starterHomeLayout";
import { useAgentStore } from "@/features/agents/stores/agentStore";

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
  onResolveBerdyAgent?: () => Promise<string | null>;
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
  onResolveBerdyAgent,
  onHydratePinnedChatSessions,
  viewportLeftOcclusionPx = 0,
}: HomeViewProps) {
  const { t } = useTranslation("home");
  const starterTasks = useStarterTasks();
  const starterTasksHeight = getStarterTasksHeight(
    starterTasks?.omittedTaskIds.size ?? 0,
  );
  const personas = useAgentStore((state) => state.personas);
  const personasLoading = useAgentStore((state) => state.personasLoading);
  const setTopBarActions = useSetTopBarActions();
  useInvalidateHomeWidgetSkillsOnChange();
  const [layoutMotionActive, setLayoutMotionActive] = useState(false);
  const pendingStarterAgentSeedRef = useRef(false);
  const pendingStarterLayoutArrangementRef = useRef(false);
  const starterLayoutItemsConfirmedRef = useRef(false);
  const starterLayoutCameraConfirmedRef = useRef(false);
  const starterAgentSeedAttemptedRef = useRef(false);
  const starterLayoutArrangementAttemptedRef = useRef(false);

  const [tourOpen, setTourOpen] = useState(false);
  const tourCompleteRef = useRef<(() => void) | null>(null);
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
    seedWidget,
    camera,
    constraints,
    saveCamera,
    cleanUpSnapshot,
    toggleCleanUpWidgets,
    syncOnboardingExperiment,
    reloadOnboardingTourForDev,
  } = useHomeWidgetLayoutController();

  useEffect(() => {
    const finishStarterLayoutIfConfirmed = () => {
      if (
        pendingStarterLayoutArrangementRef.current &&
        starterLayoutItemsConfirmedRef.current &&
        starterLayoutCameraConfirmedRef.current
      ) {
        pendingStarterLayoutArrangementRef.current = false;
        markStarterHomeArranged();
      }
    };
    const confirmItems = () => {
      if (pendingStarterAgentSeedRef.current) {
        pendingStarterAgentSeedRef.current = false;
        markStarterAgentPinsSeeded();
      }
      if (pendingStarterLayoutArrangementRef.current) {
        starterLayoutItemsConfirmedRef.current = true;
        finishStarterLayoutIfConfirmed();
      }
    };
    const confirmCamera = () => {
      if (!pendingStarterLayoutArrangementRef.current) return;
      starterLayoutCameraConfirmedRef.current = true;
      finishStarterLayoutIfConfirmed();
    };
    const discard = () => {
      pendingStarterAgentSeedRef.current = false;
      pendingStarterLayoutArrangementRef.current = false;
      starterLayoutItemsConfirmedRef.current = false;
      starterLayoutCameraConfirmedRef.current = false;
      starterAgentSeedAttemptedRef.current = false;
      starterLayoutArrangementAttemptedRef.current = false;
    };
    window.addEventListener(HOME_WIDGET_SAVE_CONFIRMED_EVENT, confirmItems);
    window.addEventListener(HOME_WIDGET_SAVE_DISCARDED_EVENT, discard);
    window.addEventListener(HOME_CAMERA_SAVE_CONFIRMED_EVENT, confirmCamera);
    window.addEventListener(HOME_CAMERA_SAVE_DISCARDED_EVENT, discard);
    return () => {
      window.removeEventListener(
        HOME_WIDGET_SAVE_CONFIRMED_EVENT,
        confirmItems,
      );
      window.removeEventListener(HOME_WIDGET_SAVE_DISCARDED_EVENT, discard);
      window.removeEventListener(
        HOME_CAMERA_SAVE_CONFIRMED_EVENT,
        confirmCamera,
      );
      window.removeEventListener(HOME_CAMERA_SAVE_DISCARDED_EVENT, discard);
    };
  }, []);

  useEffect(() => {
    if (
      loadStatus !== "ready" ||
      personasLoading ||
      pendingStarterAgentSeedRef.current ||
      starterAgentSeedAttemptedRef.current
    ) {
      return;
    }

    const haveSeededStarterAgents = haveStarterAgentPinsBeenSeeded();
    const starterAgentPinsEligible = areStarterAgentPinsEligible();
    // A missing marker is not proof of a new Home: every existing user lacks
    // this newly introduced key. Only a layout seeded from empty is eligible;
    // otherwise migrate the marker without touching the user's canvas.
    if (!haveSeededStarterAgents && !starterAgentPinsEligible) {
      markStarterAgentPinsSeeded();
      return;
    }
    const availableStarterAgents = haveSeededStarterAgents
      ? []
      : selectStarterAgentPersonas(personas);
    if (availableStarterAgents.length !== STARTER_HOME_LAYOUT.agents.length) {
      return;
    }

    const pinnedAgentIds = new Set(
      instances
        .filter((instance) => instance.type === "agentPin")
        .map((instance) => instance.state?.agentId)
        .filter((agentId): agentId is string => typeof agentId === "string"),
    );
    const missingAgents = availableStarterAgents
      .map((persona, index) => ({ persona, index }))
      .filter(({ persona }) => !pinnedAgentIds.has(persona.id));
    if (missingAgents.length === 0) {
      markStarterAgentPinsSeeded();
      return;
    }
    const allSeeded = missingAgents.every(({ persona, index }) => {
      const placement = STARTER_HOME_LAYOUT.agents[index];
      const center = placement
        ? starterLayoutCenter(placement)
        : { x: -420 + index * 220, y: 410 };
      return seedWidget(
        "agentPin",
        center.x,
        center.y,
        { agentId: persona.id },
        undefined,
        { notifyStarterTask: false },
      );
    });
    if (allSeeded) {
      starterAgentSeedAttemptedRef.current = true;
      pendingStarterAgentSeedRef.current = true;
    }
  }, [instances, loadStatus, personas, personasLoading, seedWidget]);

  useEffect(() => {
    if (
      loadStatus !== "ready" ||
      !starterTasks?.visible ||
      personasLoading ||
      hasArrangedStarterHome() ||
      pendingStarterLayoutArrangementRef.current ||
      starterLayoutArrangementAttemptedRef.current
    ) {
      return;
    }

    const starterAgentPersonas = selectStarterAgentPersonas(personas);
    const starterAgentIds = new Set(
      starterAgentPersonas.map((persona) => persona.id),
    );
    const hasCompleteStarterSet =
      starterAgentPersonas.length === STARTER_HOME_LAYOUT.agents.length &&
      starterAgentPersonas.every((persona) =>
        instances.some(
          (instance) =>
            instance.type === "agentPin" &&
            instance.state?.agentId === persona.id,
        ),
      ) &&
      instances.some((instance) => instance.type === "clock") &&
      instances.some((instance) => instance.type === "onboardingTour") &&
      instances.some(
        (instance) => instance.state?.noteId === STARTER_TASKS_NOTE_ID,
      ) &&
      instances.some(
        (instance) =>
          instance.type === "onboardingProjectArtifact" ||
          instance.state?.onboardingStarterProject === true,
      );
    if (!hasCompleteStarterSet || !isStarterHomeLayoutEligible()) {
      return;
    }

    // Guard against synchronous Zustand re-entry while the layout mutations
    // are queued. The durable marker is written only after the runtime confirms
    // the save, so a discarded save can retry on the next render.
    starterLayoutArrangementAttemptedRef.current = true;
    pendingStarterLayoutArrangementRef.current = true;
    starterLayoutItemsConfirmedRef.current = false;
    starterLayoutCameraConfirmedRef.current = camera === null;

    const starterClock = instances
      .filter((instance) => instance.type === "clock")
      .sort((left, right) => left.z - right.z)[0];

    const berdyTour = instances.find(
      (instance) => instance.type === "onboardingTour",
    );
    const maxZ = Math.max(0, ...instances.map((instance) => instance.z));
    const arrangedInstances = instances.map((instance) => {
      const noteId = instance.state?.noteId;
      if (instance.id === starterClock?.id) {
        return { ...instance, ...STARTER_HOME_LAYOUT.clock };
      }
      if (instance.type === "onboardingTour") {
        return {
          ...instance,
          x: STARTER_HOME_LAYOUT.berdy.x,
          y: STARTER_HOME_LAYOUT.berdy.y,
          z: instance.id === berdyTour?.id ? maxZ + 1 : instance.z,
        };
      }
      if (
        instance.type === "agentPin" &&
        typeof instance.state?.agentId === "string" &&
        starterAgentIds.has(instance.state.agentId)
      ) {
        const starterAgentIndex = starterAgentPersonas.findIndex(
          (persona) => persona.id === instance.state?.agentId,
        );
        const placement = STARTER_HOME_LAYOUT.agents[starterAgentIndex];
        return placement
          ? { ...instance, x: placement.x, y: placement.y }
          : instance;
      }
      if (noteId === STARTER_TASKS_NOTE_ID) {
        return {
          ...instance,
          x: STARTER_HOME_LAYOUT.tasks.x,
          y: STARTER_HOME_LAYOUT.tasks.y,
          width: STARTER_HOME_LAYOUT.tasks.width,
          height: starterTasksHeight,
        };
      }
      if (
        instance.type === "onboardingProjectArtifact" ||
        instance.state?.onboardingStarterProject === true
      ) {
        return { ...instance, ...STARTER_HOME_LAYOUT.project };
      }
      return instance;
    });
    widgetMutations.applyStarterLayout(arrangedInstances);
    if (camera) {
      saveCamera({
        ...camera,
        centerX: 80,
        centerY: 44,
        zoomBps: 9_000,
      });
    }
  }, [
    camera,
    instances,
    loadStatus,
    personas,
    personasLoading,
    saveCamera,
    starterTasks?.visible,
    starterTasksHeight,
    widgetMutations,
  ]);

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
        const noteId =
          typeof instance.state?.noteId === "string"
            ? instance.state.noteId
            : "";
        if (!starterTasks?.visible && noteId === STARTER_TASKS_NOTE_ID) {
          return false;
        }
        return !RETIRED_EDUCATIONAL_STICKY_IDS.has(noteId);
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
    const taskCenter = starterLayoutCenter(STARTER_HOME_LAYOUT.tasks);
    widgetMutations.addWidget(
      "stickyNote",
      taskCenter.x,
      taskCenter.y,
      { noteId: STARTER_TASKS_NOTE_ID },
      undefined,
      { notifyStarterTask: false },
    );
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
      return;
    }
    const projectCenter = starterLayoutCenter(STARTER_HOME_LAYOUT.project);
    widgetMutations.addWidget(
      "onboardingProjectArtifact",
      projectCenter.x,
      projectCenter.y,
      {
        projectId,
        onboardingStarterProject: true,
      },
      undefined,
      { notifyStarterTask: false },
    );
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
      x: STARTER_HOME_LAYOUT.tasks.x,
      y: STARTER_HOME_LAYOUT.tasks.y,
      z: Math.max(0, ...contentInstances.map((instance) => instance.z)) + 1,
      width: STARTER_HOME_LAYOUT.tasks.width,
      height: starterTasksHeight,
      state: { noteId: STARTER_TASKS_NOTE_ID },
    };
  }, [
    contentInstances,
    starterTasks?.docked,
    starterTasks?.visible,
    starterTasksHeight,
  ]);
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

  const handleStartTour = useCallback((onComplete?: () => void) => {
    tourCompleteRef.current = onComplete ?? null;
    setTourOpen(true);
  }, []);

  const handleTourOpenChange = useCallback((open: boolean) => {
    setTourOpen(open);
    if (!open) tourCompleteRef.current = null;
  }, []);

  const handleTourComplete = useCallback(() => {
    tourCompleteRef.current?.();
    tourCompleteRef.current = null;
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

    clearStarterHomeLayoutEligibility();
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
    clearStarterHomeLayoutEligibility();
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
          onResolveBerdyAgent={onResolveBerdyAgent}
          starterTasksAvailable={Boolean(
            starterTasks?.enabled && !starterTasks.visible,
          )}
          onRestoreStarterTasks={starterTasks?.onRestore}
        />
      ) : null}
      <OnboardingTourDialog
        open={berdyOnboardingEnabled && tourOpen}
        onOpenChange={handleTourOpenChange}
        onComplete={handleTourComplete}
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
                  className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground shadow-sm hover:bg-muted"
                  onClick={() => void retryInitialize()}
                >
                  {t("widgetLayer.error.retry")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground shadow-sm hover:bg-muted"
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
  const applyStarterLayout = useHomeWidgetStore(
    (state) => state.applyStarterLayout,
  );
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

  // The canvas-native pin/unpin paths bypass usePinToHomeWidget: the WidgetPicker
  // adds entity pins (and utility widgets) via addWidget, and the widget frame /
  // UnpinPill removes them via removeWidget. Wrap both here — the single point
  // both flow through — to record berd_home pin intents, filtered to the pinnable
  // entity kinds (clock/note/checklist widgets map to null and record nothing).
  // The intent becomes an event only if the change survives persistence; see
  // homePinTelemetry.ts.
  const addWidgetWithTelemetry = useCallback<typeof addWidget>(
    (type, x, y, state, bounds, options) => {
      const added = addWidget(type, x, y, state, bounds, options);
      if (!added) {
        return added;
      }
      const target = entityPinTargetFromWidget(type, state);
      if (target) {
        recordHomeItemPinIntent({ kind: target.kind, itemId: target.id });
      }
      return added;
    },
    [addWidget],
  );

  const removeWidgetWithTelemetry = useCallback<typeof removeWidget>(
    (id) => {
      // Resolve the entity before removal, while the instance still exists.
      const instance = useHomeWidgetStore
        .getState()
        .instances.find((candidate) => candidate.id === id);
      const target = instance
        ? entityPinTargetFromWidget(instance.type, instance.state)
        : null;
      removeWidget(id);
      if (target) {
        recordHomeItemUnpinIntent({ kind: target.kind, itemId: target.id });
      }
    },
    [removeWidget],
  );

  const widgetMutations = useMemo(
    () => ({
      addWidget: addWidgetWithTelemetry,
      moveWidget,
      resizeWidget,
      bumpZ,
      applyStarterLayout,
      removeWidget: removeWidgetWithTelemetry,
      updateWidgetState,
    }),
    [
      addWidgetWithTelemetry,
      moveWidget,
      resizeWidget,
      bumpZ,
      applyStarterLayout,
      removeWidgetWithTelemetry,
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
    // The raw store mutation, for programmatic seeding. Unlike
    // widgetMutations.addWidget it records no Pin Pinned intent: the
    // first-run starter-agent seed (and its re-run after a discarded save)
    // is not a user pin and must not count as one.
    seedWidget: addWidget,
    camera,
    constraints,
    saveCamera,
    cleanUpSnapshot,
    toggleCleanUpWidgets,
    syncOnboardingExperiment,
    reloadOnboardingTourForDev,
  };
}
