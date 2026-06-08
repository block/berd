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
    setIconCandidates([]);
    setIconScanPending(Boolean(scanKey));
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
