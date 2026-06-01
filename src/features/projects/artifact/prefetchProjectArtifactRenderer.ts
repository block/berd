import { perfLog } from "@/shared/lib/perfLog";

let rendererImportPromise: Promise<
  typeof import("./ProjectArtifactRenderer")
> | null = null;

/** Warm the three.js renderer chunk before Home mounts project cube widgets. */
export function prefetchProjectArtifactRenderer(): Promise<
  typeof import("./ProjectArtifactRenderer")
> {
  if (!rendererImportPromise) {
    const start = performance.now();
    perfLog("[perf:cube] renderer import start");
    rendererImportPromise = import("./ProjectArtifactRenderer").finally(() => {
      perfLog(
        `[perf:cube] renderer import done in ${(performance.now() - start).toFixed(1)}ms`,
      );
    });
  }

  return rendererImportPromise;
}
