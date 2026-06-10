import { useCallback, useEffect, useMemo, useState } from "react";
import {
  readProjectIcon,
  scanProjectIcons,
  type ProjectIconCandidate,
} from "../api/projects";
import {
  DEFAULT_PROJECT_ICON,
  normalizeProjectIcon,
} from "../lib/projectIcons";
import { parseEditorText } from "../lib/projectPromptText";

interface ChooseCustomProjectIconOptions {
  title: string;
  filterName: string;
}

export function useProjectIconSelection({
  isOpen,
  prompt,
}: {
  isOpen: boolean;
  prompt: string;
}) {
  const [icon, setIcon] = useState(DEFAULT_PROJECT_ICON);
  const [iconError, setIconError] = useState<string | null>(null);
  const [iconCandidates, setIconCandidates] = useState<ProjectIconCandidate[]>(
    [],
  );
  const [iconScanPending, setIconScanPending] = useState(() => {
    const initialWorkingDirKey = parseEditorText(prompt).workingDirs.join("\n");
    return isOpen && initialWorkingDirKey.length > 0;
  });

  const scannedWorkingDirKey = useMemo(
    () => parseEditorText(prompt).workingDirs.join("\n"),
    [prompt],
  );
  const shouldScanIcons = isOpen && scannedWorkingDirKey.length > 0;
  const scanKey = shouldScanIcons ? scannedWorkingDirKey : "";
  const [previousScanKey, setPreviousScanKey] = useState(scanKey);
  if (previousScanKey !== scanKey) {
    setPreviousScanKey(scanKey);
    if (scanKey) {
      // The working dirs changed and a fresh scan is queued by the effect
      // below. Keep the current candidates on screen until that scan resolves
      // so the picker row swaps its contents in one atomic update (via the
      // setIconCandidates on resolve) instead of clearing to [] now and
      // collapsing to the empty layout before re-expanding — the "icons
      // disappear then re-animate / resize" churn. On resolve the new
      // candidates replace these; on failure or empty results it still clears,
      // the same as before, so a selected candidate that no longer exists
      // falls back to the custom/upload slot exactly as it does today.
      setIconScanPending(true);
    } else {
      // No working dirs left to scan, so the effect will not run and nothing
      // would replace the candidates — clear them now to avoid showing stale
      // icons from the previous working dirs.
      setIconCandidates([]);
      setIconScanPending(false);
    }
  }

  useEffect(() => {
    const workingDirs = scanKey.split("\n").filter(Boolean);
    if (workingDirs.length === 0) {
      return;
    }

    let active = true;
    const timeout = window.setTimeout(() => {
      scanProjectIcons(workingDirs)
        .then((candidates) => {
          if (active) {
            setIconCandidates(candidates);
          }
        })
        .catch(() => {
          if (active) {
            setIconCandidates([]);
          }
        })
        .finally(() => {
          if (active) {
            setIconScanPending(false);
          }
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [scanKey]);

  const resetIcon = useCallback((nextIcon?: string | null) => {
    setIcon(normalizeProjectIcon(nextIcon));
    setIconError(null);
  }, []);

  const chooseIcon = useCallback((nextIcon: string) => {
    setIcon(nextIcon);
    setIconError(null);
  }, []);

  const chooseCustomIcon = useCallback(
    async ({ title, filterName }: ChooseCustomProjectIconOptions) => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: false,
          multiple: false,
          title,
          filters: [
            {
              name: filterName,
              extensions: ["svg", "png", "ico", "jpg", "jpeg", "webp"],
            },
          ],
        });
        if (selected && typeof selected === "string") {
          const iconData = await readProjectIcon(selected);
          setIcon(iconData.icon);
          setIconError(null);
        }
      } catch (err) {
        setIconError(String(err));
      }
    },
    [],
  );

  return {
    icon,
    iconCandidates,
    iconScanPending,
    iconError,
    chooseIcon,
    chooseCustomIcon,
    resetIcon,
  };
}
