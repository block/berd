/** Warm the three.js renderer chunk before Home mounts project cube widgets. */
export function prefetchProjectArtifactRenderer(): Promise<unknown> {
  return import("./ProjectArtifactRenderer");
}
