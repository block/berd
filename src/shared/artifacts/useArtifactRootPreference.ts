import { useCallback, useEffect, useState } from "react";
import {
  ARTIFACT_ROOT_CHANGED_EVENT,
  defaultArtifactRootPath,
  getArtifactRootPreference,
  setArtifactRootPreference,
} from "./sessionArtifactLocation";

export function useArtifactRootPreference() {
  const [defaultRootPath, setDefaultRootPath] = useState<string | null>(null);
  const [customRootPath, setCustomRootPath] = useState<string | null>(() =>
    getArtifactRootPreference(),
  );

  const syncDefaultRoot = useCallback(async () => {
    const resolved = await defaultArtifactRootPath();
    setDefaultRootPath(resolved);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;

    const sync = async () => {
      const [configured, resolvedDefault] = await Promise.all([
        Promise.resolve(getArtifactRootPreference()),
        defaultArtifactRootPath(),
      ]);
      if (cancelled) {
        return;
      }
      setCustomRootPath(configured);
      setDefaultRootPath(resolvedDefault);
    };

    const handleChange = () => {
      void sync();
    };

    window.addEventListener(
      ARTIFACT_ROOT_CHANGED_EVENT,
      handleChange as EventListener,
    );
    void sync();

    return () => {
      cancelled = true;
      window.removeEventListener(
        ARTIFACT_ROOT_CHANGED_EVENT,
        handleChange as EventListener,
      );
    };
  }, []);

  const setRootPath = useCallback(async (path: string) => {
    setArtifactRootPreference(path);
    setCustomRootPath(path.trim() || null);
  }, []);

  const resetRootPath = useCallback(async () => {
    setArtifactRootPreference(null);
    setCustomRootPath(null);
    await syncDefaultRoot();
  }, [syncDefaultRoot]);

  return {
    rootPath: customRootPath ?? defaultRootPath,
    customRootPath,
    defaultRootPath,
    hasCustomRoot: customRootPath !== null,
    setRootPath,
    resetRootPath,
  };
}
