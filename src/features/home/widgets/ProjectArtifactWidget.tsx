import { useMemo, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { ProjectArtifactPreview } from "@/features/projects/artifact/ProjectArtifactPreview";
import type {
  ProjectArtifactInput,
  ProjectArtifactMotionImpulse,
} from "@/features/projects/artifact/types";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { cn } from "@/shared/lib/cn";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getProjectId(
  state: Record<string, unknown> | undefined,
): string | null {
  return typeof state?.projectId === "string" ? state.projectId : null;
}

function clampPointerImpulse(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0.3, Math.min(0.3, value));
}

function getPointerVelocityBoost(
  deltaX: number,
  deltaY: number,
  elapsedMs: number,
) {
  const normalizedDistance = Math.hypot(deltaX, deltaY);
  const safeElapsedMs = Number.isFinite(elapsedMs) ? elapsedMs : 8;
  const seconds = Math.max(safeElapsedMs, 8) / 1000;
  const velocity = normalizedDistance / seconds;

  return Math.max(0.9, Math.min(3.1, 1 + velocity * 0.22));
}

export function ProjectArtifactWidget({
  instance,
  shouldIgnoreActivation,
  onStartProjectChat,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const projects = useProjectStore(selectProjects);
  const sessions = useChatSessionStore((state) => state.sessions);
  const projectId = getProjectId(instance.state);
  const project = projects.find((candidate) => candidate.id === projectId);
  const sessionCount = useMemo(
    () =>
      project
        ? sessions.filter(
            (session) =>
              session.projectId === project.id && session.archivedAt == null,
          ).length
        : 0,
    [project, sessions],
  );

  const input = useMemo<ProjectArtifactInput>(
    () =>
      project
        ? {
            projectId: project.id,
            name: project.name,
            prompt: project.prompt,
            color: project.color,
            workingDirs: project.workingDirs,
            sessionCount,
            artifact: project.artifact ?? null,
          }
        : {
            projectId,
            name: t("widgets.projectArtifactPin.unavailableTitle"),
            color: null,
            workingDirs: [],
            sessionCount: 0,
            artifact: null,
          },
    [project, projectId, sessionCount, t],
  );

  const label =
    project?.name ?? t("widgets.projectArtifactPin.unavailableTitle");
  const lastPointerPosition = useRef<{
    time: number;
    x: number;
    y: number;
  } | null>(null);
  const [motionImpulse, setMotionImpulse] =
    useState<ProjectArtifactMotionImpulse>();
  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (project) onStartProjectChat?.(project.id);
  });
  const rememberPointerPosition = (event: PointerEvent<HTMLButtonElement>) => {
    lastPointerPosition.current = {
      time: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    rememberPointerPosition(event);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!project || shouldIgnoreActivation?.()) {
      lastPointerPosition.current = null;
      return;
    }

    const currentPosition = {
      time: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    };
    const previousPosition = lastPointerPosition.current;
    lastPointerPosition.current = currentPosition;
    if (!previousPosition) return;

    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const deltaX = event.clientX - previousPosition.x;
    const deltaY = event.clientY - previousPosition.y;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    const normalizedDeltaX = deltaX / rect.width;
    const normalizedDeltaY = deltaY / rect.height;
    const velocityBoost = getPointerVelocityBoost(
      normalizedDeltaX,
      normalizedDeltaY,
      currentPosition.time - previousPosition.time,
    );

    setMotionImpulse((previous) => ({
      sequence: (previous?.sequence ?? 0) + 1,
      deltaX: clampPointerImpulse(normalizedDeltaX * velocityBoost),
      deltaY: clampPointerImpulse(normalizedDeltaY * velocityBoost),
    }));
  };
  const handlePointerLeave = () => {
    lastPointerPosition.current = null;
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerLeave={handlePointerLeave}
      onPointerMove={handlePointerMove}
      disabled={!project}
      aria-label={
        project
          ? t("widgets.projectArtifactPin.openAria", { name: project.name })
          : t("widgets.projectArtifactPin.unavailableTitle")
      }
      className={cn(
        "group relative h-full w-full overflow-visible rounded-card-chat bg-transparent text-left text-foreground transition-opacity duration-150 cursor-pointer",
        project ? "hover:opacity-95" : "cursor-not-allowed opacity-70",
      )}
    >
      <div className="pointer-events-none absolute inset-0 overflow-visible">
        <div className="pointer-events-auto absolute top-[47%] left-[49%] h-[320px] w-[320px] -translate-x-1/2 -translate-y-1/2">
          <ProjectArtifactPreview
            input={input}
            motionImpulse={motionImpulse}
            variant="tile"
          />
        </div>
      </div>
      <span
        aria-hidden="true"
        data-testid="project-artifact-hover-label"
        className="pointer-events-none absolute bottom-3 left-1/2 z-10 max-w-[calc(100%-1.5rem)] -translate-x-1/2 truncate rounded-full bg-card/90 px-2.5 py-1 text-xs font-medium text-foreground opacity-0 backdrop-blur-md transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {label}
      </span>
    </button>
  );
}
