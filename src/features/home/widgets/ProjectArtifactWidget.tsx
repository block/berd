import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type PointerEvent,
} from "react";
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
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import { useWidgetGestureFreeze } from "./useWidgetGestureFreeze";
import type { WidgetRenderProps } from "./types";
import { STARTER_PROJECT_ID } from "@/features/home/onboarding/starterTasks";

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
  canvasGestureActive = false,
  canvasGestureKind,
  widgetResizePreviewActive = false,
  renderPaused = false,
  shouldIgnoreActivation,
  onTagProjectInComposer,
  onStartProjectChat,
  onCreateProject,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const { enabled: alwaysShowLabel } = useHomePinLabelsPreference();
  const projects = useProjectStore(selectProjects);
  const sessions = useChatSessionStore((state) => state.sessions);
  const projectId = getProjectId(instance.state);
  const project = projects.find((candidate) => candidate.id === projectId);
  const isStarterProject =
    (instance.type === "onboardingProjectArtifact" ||
      projectId === STARTER_PROJECT_ID) &&
    !project;
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
            name: isStarterProject
              ? t("widgets.projectArtifactPin.starterTitle")
              : t("widgets.projectArtifactPin.unavailableTitle"),
            color: isStarterProject ? "blue" : null,
            workingDirs: [],
            sessionCount: 0,
            artifact: null,
          },
    [isStarterProject, project, projectId, sessionCount, t],
  );

  const label =
    project?.name ??
    (isStarterProject
      ? t("widgets.projectArtifactPin.starterTitle")
      : t("widgets.projectArtifactPin.unavailableTitle"));
  const lastPointerPosition = useRef<{
    time: number;
    x: number;
    y: number;
  } | null>(null);
  const [motionImpulse, setMotionImpulse] =
    useState<ProjectArtifactMotionImpulse>();
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerDownSnapshotRef = useRef<string | null>(null);
  const captureCanvasSnapshot = useCallback(() => {
    const canvas = glCanvasRef.current;
    if (!canvas) {
      return null;
    }
    try {
      const snapshot = canvas.toDataURL("image/png");
      return snapshot && snapshot !== "data:," ? snapshot : null;
    } catch {
      return null;
    }
  }, []);
  const captureGestureSnapshot = useCallback(() => {
    if (canvasGestureKind === "drag") {
      const pointerDownSnapshot = pointerDownSnapshotRef.current;
      pointerDownSnapshotRef.current = null;
      return pointerDownSnapshot ?? captureCanvasSnapshot();
    }

    // Resize begins from sibling chrome, not the project button. Always capture
    // the current canvas instead of borrowing a snapshot prepared for a click
    // or an earlier drag.
    return captureCanvasSnapshot();
  }, [canvasGestureKind, captureCanvasSnapshot]);
  const shouldFreezeVisual = canvasGestureActive && !widgetResizePreviewActive;
  useLayoutEffect(() => {
    if (!canvasGestureActive) {
      pointerDownSnapshotRef.current = null;
    }
  }, [canvasGestureActive]);
  const gestureSnapshot = useWidgetGestureFreeze(
    shouldFreezeVisual,
    captureGestureSnapshot,
  );

  const handleGuardedClick = useWidgetActivationGuard(
    shouldIgnoreActivation,
    () => {
      if (project) {
        (onTagProjectInComposer ?? onStartProjectChat)?.(project.id);
      } else if (isStarterProject) {
        onCreateProject?.();
      }
    },
  );
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (onTagProjectInComposer) {
      event.stopPropagation();
    }
    handleGuardedClick(event);
  };
  const rememberPointerPosition = (event: PointerEvent<HTMLButtonElement>) => {
    lastPointerPosition.current = {
      time: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // Capture before the canvas starts moving. WKWebView can briefly expose a
    // blank WebGL backing surface after the widget's compositor position
    // changes, which made the delayed drag snapshot intermittently invisible.
    pointerDownSnapshotRef.current = captureCanvasSnapshot();
    rememberPointerPosition(event);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if ((!project && !isStarterProject) || canvasGestureActive) {
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
  const clearPreparedSnapshot = () => {
    pointerDownSnapshotRef.current = null;
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={clearPreparedSnapshot}
      onPointerCancel={clearPreparedSnapshot}
      onPointerEnter={rememberPointerPosition}
      onPointerLeave={handlePointerLeave}
      onPointerMove={handlePointerMove}
      disabled={!project && !isStarterProject}
      aria-label={
        project
          ? t("widgets.projectArtifactPin.openAria", { name: project.name })
          : isStarterProject
            ? t("widgets.projectArtifactPin.starterAria")
            : t("widgets.projectArtifactPin.unavailableTitle")
      }
      className={cn(
        "group relative isolate flex h-full w-full flex-col items-center overflow-visible rounded-md bg-transparent text-left text-foreground transition-opacity duration-150 cursor-pointer [transform:translateZ(0)]",
        project || isStarterProject
          ? "hover:opacity-95"
          : "cursor-not-allowed opacity-70",
      )}
    >
      <div className="pointer-events-none relative flex min-h-0 w-full flex-1 items-center justify-center overflow-visible">
        {gestureSnapshot ? (
          <img
            alt=""
            aria-hidden="true"
            src={gestureSnapshot}
            className="pointer-events-none absolute inset-0 z-20 m-auto aspect-square w-[96%] max-h-full max-w-full object-contain"
          />
        ) : null}
        <div
          className={cn(
            "pointer-events-auto aspect-square w-[96%] max-h-full max-w-full min-h-0 min-w-0",
            gestureSnapshot && "invisible",
          )}
        >
          <ProjectArtifactPreview
            input={input}
            gestureFreezeActive={shouldFreezeVisual}
            motionImpulse={motionImpulse}
            renderPaused={renderPaused}
            onGlCanvasReady={(canvas) => {
              glCanvasRef.current = canvas;
            }}
            variant="tile"
          />
        </div>
      </div>
      <span
        aria-hidden="true"
        data-testid="project-artifact-hover-label"
        className={cn(
          "pointer-events-none absolute bottom-[13%] left-1/2 z-30 max-w-[calc(100%-1.25rem)] -translate-x-1/2 truncate rounded-full bg-card/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-md transition-opacity duration-150",
          alwaysShowLabel
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      >
        {label}
      </span>
    </button>
  );
}
