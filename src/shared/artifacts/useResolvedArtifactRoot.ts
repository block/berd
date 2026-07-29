import { useEffect, useState } from "react";
import {
  ARTIFACT_ROOT_CHANGED_EVENT,
  resolveArtifactRootPath,
} from "./sessionArtifactLocation";

/**
 * The artifact root as an absolute path, matching what the backend uses as a
 * projectless session's working directory.
 *
 * This exists because `useArtifactRootPreference().rootPath` can return the
 * *stored* preference verbatim (for example `~/my docs`), while artifact
 * locations arrive resolved (`/Users/…/my docs`). Consumers that compare the
 * root against resolved paths — the auto-open scope gate — must use this hook,
 * or a custom root would silently never match and the comparison would be
 * dead without any visible failure.
 *
 * Returns `null` until the first resolution completes. `resolveArtifactRootPath`
 * is read-only (unlike `resolveSessionArtifactCwd`, it does not create the
 * directory), so mounting this hook has no filesystem side effects.
 */
export function useResolvedArtifactRoot(): string | null {
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    const sync = () => {
      void resolveArtifactRootPath()
        .then((path) => {
          if (!cancelled) setResolvedRoot(path);
        })
        .catch(() => {
          // Leave the previous value; a transient resolve failure should not
          // flip consumers into the "no root" state.
        });
    };

    window.addEventListener(ARTIFACT_ROOT_CHANGED_EVENT, sync);
    sync();

    return () => {
      cancelled = true;
      window.removeEventListener(ARTIFACT_ROOT_CHANGED_EVENT, sync);
    };
  }, []);

  return resolvedRoot;
}
