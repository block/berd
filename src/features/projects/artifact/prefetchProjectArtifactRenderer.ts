let rendererImportPromise: Promise<
  typeof import("./ProjectArtifactRenderer")
> | null = null;

/** Warm the three.js renderer chunk before Home mounts project cube widgets. */
export function prefetchProjectArtifactRenderer(): Promise<
  typeof import("./ProjectArtifactRenderer")
> {
  if (!rendererImportPromise) {
    rendererImportPromise = import("./ProjectArtifactRenderer");
  }

  return rendererImportPromise;
}
