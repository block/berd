import { lazy, Suspense, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getProjectArtifactAssets,
  PROJECT_ARTIFACT_ASSETS_QUERY_KEY,
} from "@/shared/api/projectArtifactAssets";
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
}

function canUseWebGlRenderer(): boolean {
  return typeof window !== "undefined" && import.meta.env.MODE !== "test";
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
          className="absolute top-[9%] left-[18%] h-[72%] w-[64%] rounded-full blur-3xl transition-colors duration-700 ease-out"
          style={{
            background: state.accentCssColor,
            opacity: 0.42,
          }}
        />
      )}
      <div
        className="relative aspect-square w-[44%] rounded-[22%] bg-white/30 shadow-[0_26px_70px_rgba(15,23,42,0.16)] backdrop-blur-xl"
        aria-hidden="true"
      />
    </div>
  );
}

export function ProjectArtifactPreview({
  input,
  className,
  motionImpulse,
  variant = "preview",
}: ProjectArtifactPreviewProps) {
  const state = useMemo(() => deriveProjectArtifactState(input), [input]);
  const canUseRenderer = canUseWebGlRenderer();
  const assetQuery = useQuery({
    queryKey: PROJECT_ARTIFACT_ASSETS_QUERY_KEY,
    queryFn: getProjectArtifactAssets,
    enabled: canUseRenderer,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: "always",
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
        variant === "tile" ? "rounded-card-chat" : "rounded-[28px]",
      )}
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
          motionImpulse={motionImpulse}
          state={state}
          variant={variant}
        />
      </Suspense>
    </div>
  );
}
