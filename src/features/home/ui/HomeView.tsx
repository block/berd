import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SkillInfo } from "@/features/skills/api/skills";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import { WidgetCanvas } from "./WidgetCanvas";

export interface HomeViewProps {
  onOpenProject?: (projectId: string) => void;
  onOpenSkill?: (skill: SkillInfo) => void;
  onOpenAgent?: (agentId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onStartProjectChat?: (projectId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
}

export function HomeView({
  onOpenProject,
  onOpenSkill,
  onOpenAgent,
  onSelectSession,
  onStartProjectChat,
  onOpenAutomation,
}: HomeViewProps) {
  const { t } = useTranslation("home");
  const {
    instances,
    loadStatus,
    error,
    retryInitialize,
    copyErrorDetails,
    widgetMutations,
  } = useHomeWidgetLayoutController();

  return (
    <div className="relative h-full w-full">
      {loadStatus === "ready" ? (
        <WidgetCanvas
          instances={instances}
          mutations={widgetMutations}
          onOpenProject={onOpenProject}
          onOpenSkill={onOpenSkill}
          onOpenAgent={onOpenAgent}
          onSelectSession={onSelectSession}
          onStartProjectChat={onStartProjectChat}
          onOpenAutomation={onOpenAutomation}
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

function useHomeWidgetLayoutController() {
  const instances = useHomeWidgetStore((state) => state.instances);
  const loadStatus = useHomeWidgetStore((state) => state.loadStatus);
  const error = useHomeWidgetStore((state) => state.error);
  const initialize = useHomeWidgetStore((state) => state.initialize);
  const retryInitialize = useHomeWidgetStore((state) => state.retryInitialize);
  const copyErrorDetails = useHomeWidgetStore(
    (state) => state.copyErrorDetails,
  );
  const addWidget = useHomeWidgetStore((state) => state.addWidget);
  const moveWidget = useHomeWidgetStore((state) => state.moveWidget);
  const resizeWidget = useHomeWidgetStore((state) => state.resizeWidget);
  const bumpZ = useHomeWidgetStore((state) => state.bumpZ);
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
  };
}
