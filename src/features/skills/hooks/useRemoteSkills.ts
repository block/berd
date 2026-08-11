import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import {
  getSkillCliStatus,
  installRemoteSkill,
  listRemoteSkills,
  type InstallRemoteSkillOptions,
  type RemoteSkill,
} from "../api/skillMarketplace";
import { listenSkillsChanged } from "../lib/skillsEvents";

export type CatalogState = "idle" | "loading" | "ready" | "error";

type CliState = "unknown" | "checking" | "available" | "unavailable";

export interface UseRemoteSkillsResult {
  cliState: CliState;
  skills: RemoteSkill[];
  loading: boolean;
  catalogState: CatalogState;
  installing: Set<string>;
  reload: () => Promise<void>;
  install: (
    skill: RemoteSkill,
    options?: InstallRemoteSkillOptions & { destinationLabel?: string | null },
  ) => Promise<void>;
}

/**
 * Loads the remote skill catalog and tracks CLI availability + per-skill
 * install state for the discovery UI.
 *
 * Loading begins when `enabled` becomes true. Callers can suppress load-error
 * toasts for background catalog reads while still exposing `catalogState` for
 * an inline retry state. The hook is owned by `SkillsView` so its state
 * survives the grid → detail-page transition; that keeps install state and the
 * loaded catalog warm when the user navigates back from a skill's detail view.
 */
export function useRemoteSkills(
  enabled: boolean,
  reportLoadErrors = true,
): UseRemoteSkillsResult {
  const { t } = useTranslation(["skills", "common"]);
  const [cliState, setCliState] = useState<CliState>("unknown");
  const [skills, setSkills] = useState<RemoteSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogState, setCatalogState] = useState<CatalogState>("idle");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const loadRequestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const reportLoadErrorsRef = useRef(false);
  const enabledRef = useRef(false);

  useEffect(() => {
    reportLoadErrorsRef.current = reportLoadErrors;
    enabledRef.current = enabled;
  }, [enabled, reportLoadErrors]);

  const load = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    hasLoadedRef.current = true;
    setLoading(true);
    setCatalogState("loading");
    setCliState((current) => (current === "unknown" ? "checking" : current));
    try {
      const status = await getSkillCliStatus();
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      if (!status.available) {
        setCliState("unavailable");
        setCatalogState("idle");
        setSkills([]);
        return;
      }
      setCliState("available");
      const catalog = await listRemoteSkills();
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      setSkills(catalog);
      setCatalogState("ready");
    } catch (error) {
      if (loadRequestIdRef.current === requestId) {
        setSkills([]);
        setCatalogState("error");
        if (enabledRef.current && reportLoadErrorsRef.current) {
          toast.error(formatAcpErrorMessage(error, t("discover.loadError")));
        }
      }
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      // Invalidate pending requests so hidden Discover work cannot update state
      // or notify after the feature is disabled.
      loadRequestIdRef.current += 1;
      hasLoadedRef.current = false;
      setLoading(false);
      setCatalogState("idle");
      return;
    }
    if (!hasLoadedRef.current) {
      void load();
    }
    return () => {
      enabledRef.current = false;
      const requestIdAtCleanup = loadRequestIdRef.current;
      queueMicrotask(() => {
        // StrictMode and dependency replays run the next setup before this
        // microtask. Only invalidate when the hook remained disabled/unmounted.
        if (
          !enabledRef.current &&
          loadRequestIdRef.current === requestIdAtCleanup
        ) {
          loadRequestIdRef.current += 1;
          hasLoadedRef.current = false;
        }
      });
    };
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return listenSkillsChanged(() => {
      hasLoadedRef.current = false;
      void load();
    });
  }, [enabled, load]);

  const reload = useCallback(async () => {
    hasLoadedRef.current = false;
    await load();
  }, [load]);

  const install = useCallback(
    async (
      skill: RemoteSkill,
      options: InstallRemoteSkillOptions & {
        destinationLabel?: string | null;
      } = {},
    ) => {
      const { destinationLabel, ...installOptions } = options;
      setInstalling((current) => new Set(current).add(skill.name));
      try {
        await installRemoteSkill(skill.name, installOptions);
        setSkills((current) =>
          current.map((entry) =>
            entry.name === skill.name ? { ...entry, installed: true } : entry,
          ),
        );
        toast.success(
          destinationLabel
            ? t("discover.installSuccessInProject", {
                name: skill.name,
                project: destinationLabel,
              })
            : t("discover.installSuccess", { name: skill.name }),
        );
      } catch (error) {
        toast.error(formatAcpErrorMessage(error, t("discover.installError")));
      } finally {
        setInstalling((current) => {
          const next = new Set(current);
          next.delete(skill.name);
          return next;
        });
      }
    },
    [t],
  );

  return {
    cliState,
    skills,
    loading,
    catalogState,
    installing,
    reload,
    install,
  };
}
