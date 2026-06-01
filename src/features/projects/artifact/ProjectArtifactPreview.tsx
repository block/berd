import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { selectProjectPreviewArtifacts } from "@/shared/api/artifacts";
import { useArtifacts } from "@/shared/hooks/useArtifacts";
import { cn } from "@/shared/lib/cn";
import { deriveProjectArtifactState } from "./deriveProjectArtifactState";
import type {
  ProjectArtifactInput,
  ProjectArtifactRendererProps,
} from "./types";

const LazyProjectArtifactRenderer = lazy(() =>
  import("./ProjectArtifactRenderer").then((module) => ({
    default: module.ProjectArtifactRenderer,
  })),
);

interface ProjectArtifactPreviewProps {
  input: ProjectArtifactInput;
  className?: string;
  variant?: ProjectArtifactRendererProps["variant"];
  motionImpulse?: ProjectArtifactRendererProps["motionImpulse"];
  gestureFreezeActive?: boolean;
  onGlCanvasReady?: (canvas: HTMLCanvasElement) => void;
}

function canUseWebGlRenderer(): boolean {
  return typeof window !== "undefined";
}

function ProjectArtifactFallback({
  className,
  state,
  variant,
}: Pick<ProjectArtifactRendererProps, "className" | "state" | "variant">) {
  const isTile = variant === "tile";

  return (
    <div
      data-testid="project-artifact-preview"
      className={cn(
        "relative isolate flex h-full w-full items-center justify-center",
        isTile
          ? "overflow-visible bg-transparent"
          : "overflow-hidden rounded-[28px] bg-transparent",
        className,
      )}
    >
      {isTile ? null : (
        <div
          className="absolute inset-[8%] transition-colors duration-700 ease-out"
          style={{
            background: `radial-gradient(ellipse at center, ${state.accentCssColor} 0%, ${state.accentCssColor} 28%, transparent 66%)`,
            opacity: 0.34,
          }}
        />
      )}
      <div
        className={cn(
          "relative aspect-square w-[44%] rounded-[22%]",
          isTile
            ? "bg-white/55 shadow-[0_22px_60px_rgba(15,23,42,0.14)]"
            : "bg-white/30 shadow-[0_26px_70px_rgba(15,23,42,0.16)] backdrop-blur-xl",
        )}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * Catches WebGL/three.js failures inside the r3f Canvas (context lost,
 * context-limit exhaustion on view transitions, etc.) and degrades to the
 * static fallback instead of crashing the whole view. The boundary resets on
 * `resetKey` change so a different project gets a fresh attempt.
 */
interface RendererErrorBoundaryProps {
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  errored: boolean;
}

class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { errored: false };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { errored: true };
  }

  componentDidUpdate(prevProps: RendererErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.errored) {
      this.setState({ errored: false });
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn(
      "ProjectArtifactRenderer crashed; falling back to static preview.",
      error,
      info,
    );
  }

  render() {
    return this.state.errored ? this.props.fallback : this.props.children;
  }
}

export function ProjectArtifactPreview({
  input,
  className,
  motionImpulse,
  gestureFreezeActive,
  onGlCanvasReady,
  variant = "preview",
}: ProjectArtifactPreviewProps) {
  const state = useMemo(() => deriveProjectArtifactState(input), [input]);
  const canUseRenderer = canUseWebGlRenderer();
  const assetQuery = useArtifacts({
    enabled: canUseRenderer,
    select: selectProjectPreviewArtifacts,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(250 * 2 ** attemptIndex, 2000),
  });

  useEffect(() => {
    if (assetQuery.error) {
      console.warn("Failed to load project artifact assets.", assetQuery.error);
    }
  }, [assetQuery.error]);

  if (!canUseRenderer || !assetQuery.data) {
    return (
      <ProjectArtifactFallback
        className={className}
        state={state}
        variant={variant}
      />
    );
  }

  return (
    <div
      data-testid="project-artifact-preview"
      className={cn(
        "h-full w-full",
        variant === "tile" ? "overflow-visible" : "rounded-[28px]",
      )}
    >
      <RendererErrorBoundary
        resetKey={input.projectId ?? "no-project"}
        fallback={
          <ProjectArtifactFallback
            className={className}
            state={state}
            variant={variant}
          />
        }
      >
        <Suspense
          fallback={
            <ProjectArtifactFallback
              className={className}
              state={state}
              variant={variant}
            />
          }
        >
          <LazyProjectArtifactRenderer
            className={className}
            environmentUrl={assetQuery.data.environmentUrl}
            imageUrls={assetQuery.data.imageUrls}
            gestureFreezeActive={gestureFreezeActive}
            motionImpulse={motionImpulse}
            onGlCanvasReady={onGlCanvasReady}
            state={state}
            variant={variant}
          />
        </Suspense>
      </RendererErrorBoundary>
    </div>
  );
}
