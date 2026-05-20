import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import { WidgetCanvas } from "./WidgetCanvas";
import { HomeComposer } from "./HomeComposer";

export interface HomeViewProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
  onOpenAgent?: (agentId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
}

export function HomeView({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onCreateProject,
  onOpenAgent,
  onSelectSession,
  onOpenAutomation,
}: HomeViewProps) {
  const { t } = useTranslation("home");
  const instances = useHomeWidgetStore((state) => state.instances);
  const loadStatus = useHomeWidgetStore((state) => state.loadStatus);
  const error = useHomeWidgetStore((state) => state.error);
  const initialize = useHomeWidgetStore((state) => state.initialize);
  const retryInitialize = useHomeWidgetStore((state) => state.retryInitialize);
  const copyErrorDetails = useHomeWidgetStore(
    (state) => state.copyErrorDetails,
  );

  useEffect(() => {
    void initialize();
  }, [initialize]);

  return (
    <div className="relative h-full w-full">
      {loadStatus === "ready" ? (
        <WidgetCanvas
          instances={instances}
          onOpenAgent={onOpenAgent}
          onSelectSession={onSelectSession}
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
      {/* Composer pinned at bottom-center, not draggable */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-4">
        <div className="pointer-events-auto w-full max-w-[640px]">
          <HomeComposer
            sessionId={sessionId}
            onActivateSession={onActivateSession}
            onCreatePersona={onCreatePersona}
            onCreateProject={onCreateProject}
          />
        </div>
      </div>
    </div>
  );
}
