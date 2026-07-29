import { Crosshair, LayoutGrid } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { prefetchProjectArtifactRenderer } from "@/features/projects/artifact/prefetchProjectArtifactRenderer";
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
  onHydratePinnedChatSessions,
  viewportLeftOcclusionPx = 0,
}: HomeViewProps) {
  const { t } = useTranslation("home");
  const setTopBarActions = useSetTopBarActions();
  useInvalidateHomeWidgetSkillsOnChange();
  const [layoutMotionActive, setLayoutMotionActive] = useState(false);
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
  } = useHomeWidgetLayoutController();
  const recenterTarget = useMemo(
    () => widgetCenterOfGravity(instances),
    [instances],
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
          title={cleanUpControlTitle}
        >
          <LayoutGrid aria-hidden="true" />
        </TopBarIconButton>
        <TopBarIconButton
          type="button"
          onClick={handleRecenter}
          disabled={!recenterTarget}
          aria-label={recenterTitle}
          title={recenterTitle}
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
          instances={instances}
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
        />
      ) : null}
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
  };
}
