import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  DownloadEvent,
  Update as TauriUpdate,
} from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  | "unavailable"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

type CheckForUpdateOptions = {
  background?: boolean;
  quiet?: boolean;
};

type UpdaterContextValue = {
  status: UpdateStatus;
  enabled: boolean;
  availableVersion: string | null;
  downloadProgress: number | null;
  errorMessage: string | null;
  checkForUpdate: (options?: CheckForUpdateOptions) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  relaunch: () => Promise<void>;
};

type UpdaterProviderProps = {
  children: ReactNode;
  checkIntervalMs?: number;
  runStartupCheck?: boolean;
};

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;
const ACTIVE_UPDATE_STATUSES = new Set<UpdateStatus>([
  "available",
  "downloading",
  "installing",
  "ready",
]);

const UpdaterContext = createContext<UpdaterContextValue | undefined>(
  undefined,
);

function isDevMode() {
  const dev = import.meta.env.DEV as boolean | string;
  return dev === true || dev === "true";
}

function isUpdaterEnabled() {
  return (
    import.meta.env.VITE_UPDATER_ENABLED === "true" &&
    !isDevMode() &&
    typeof window !== "undefined" &&
    Boolean(window.__TAURI_INTERNALS__)
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function initialStatus() {
  return isUpdaterEnabled() ? "idle" : "unavailable";
}

export function UpdaterProvider({
  children,
  checkIntervalMs = CHECK_INTERVAL_MS,
  runStartupCheck = true,
}: UpdaterProviderProps) {
  const { t } = useTranslation("settings");
  const enabled = isUpdaterEnabled();
  const [status, setStatus] = useState<UpdateStatus>(initialStatus);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const statusRef = useRef<UpdateStatus>(status);
  const updateRef = useRef<TauriUpdate | null>(null);
  const checkPromiseRef = useRef<Promise<void> | null>(null);
  const installPromiseRef = useRef<Promise<void> | null>(null);
  const downloadedBytesRef = useRef(0);
  const downloadTotalBytesRef = useRef<number | null>(null);

  const setStatusValue = useCallback((nextStatus: UpdateStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const recordError = useCallback(
    (error: unknown, fallbackMessage = t("updates.errors.generic")) => {
      console.warn(`[updater] ${getErrorMessage(error)}`);
      const message = fallbackMessage;
      setErrorMessage(message);
      setStatusValue("error");
      toast.error(t("updates.toast.error.title"), {
        description: t("updates.toast.error.description", { message }),
      });
    },
    [setStatusValue, t],
  );

  const relaunch = useCallback(async () => {
    if (!enabled) {
      setStatusValue("unavailable");
      return;
    }

    try {
      const { relaunch: restartApp } = await import(
        "@tauri-apps/plugin-process"
      );
      await restartApp();
    } catch (error) {
      recordError(error);
    }
  }, [enabled, recordError, setStatusValue]);

  const downloadAndInstallUpdate = useCallback(
    async (update: TauriUpdate) => {
      if (installPromiseRef.current) {
        return installPromiseRef.current;
      }

      const installPromise = (async () => {
        setErrorMessage(null);
        downloadedBytesRef.current = 0;
        downloadTotalBytesRef.current = null;
        setDownloadProgress(null);
        setStatusValue("downloading");

        try {
          await update.downloadAndInstall((event: DownloadEvent) => {
            if (event.event === "Started") {
              downloadedBytesRef.current = 0;
              downloadTotalBytesRef.current = event.data.contentLength ?? null;
              setDownloadProgress(event.data.contentLength ? 0 : null);
              setStatusValue("downloading");
              return;
            }

            if (event.event === "Progress") {
              downloadedBytesRef.current += event.data.chunkLength;
              const totalBytes = downloadTotalBytesRef.current;
              setDownloadProgress(
                totalBytes
                  ? Math.min(
                      99,
                      Math.round(
                        (downloadedBytesRef.current / totalBytes) * 100,
                      ),
                    )
                  : null,
              );
              setStatusValue("downloading");
              return;
            }

            setDownloadProgress(100);
            setStatusValue("installing");
          });

          setDownloadProgress(100);
          setStatusValue("ready");
          toast.success(t("updates.toast.ready.title"), {
            description: t("updates.toast.ready.description", {
              version: update.version,
            }),
            duration: Infinity,
            action: {
              label: t("updates.actions.restart"),
              onClick: () => {
                void relaunch();
              },
            },
          });
        } catch (error) {
          recordError(error);
        }
      })();

      installPromiseRef.current = installPromise;
      try {
        await installPromise;
      } finally {
        if (installPromiseRef.current === installPromise) {
          installPromiseRef.current = null;
        }
      }
    },
    [recordError, relaunch, setStatusValue, t],
  );

  const downloadAndInstall = useCallback(async () => {
    if (!enabled) {
      setStatusValue("unavailable");
      return;
    }

    const update = updateRef.current;
    if (!update) {
      return;
    }

    await downloadAndInstallUpdate(update);
  }, [downloadAndInstallUpdate, enabled, setStatusValue]);

  const checkForUpdate = useCallback(
    async (options: CheckForUpdateOptions = {}) => {
      if (!enabled) {
        setStatusValue("unavailable");
        return;
      }

      const currentStatus = statusRef.current;
      if (
        currentStatus === "checking" ||
        ACTIVE_UPDATE_STATUSES.has(currentStatus)
      ) {
        if (options.background) {
          return;
        }
        return (
          checkPromiseRef.current ?? installPromiseRef.current ?? undefined
        );
      }

      if (checkPromiseRef.current) {
        return checkPromiseRef.current;
      }

      const checkPromise = (async () => {
        setErrorMessage(null);
        setDownloadProgress(null);
        setStatusValue("checking");

        try {
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check({ timeout: CHECK_TIMEOUT_MS });

          if (!update) {
            updateRef.current = null;
            setAvailableVersion(null);
            setStatusValue("up-to-date");
            return;
          }

          updateRef.current = update;
          setAvailableVersion(update.version);
          setStatusValue("available");
          await downloadAndInstallUpdate(update);
        } catch (error) {
          if (options.quiet) {
            console.warn(`[updater] check failed: ${getErrorMessage(error)}`);
            setStatusValue("idle");
            return;
          }

          recordError(error, t("updates.errors.networkAccess"));
        }
      })();

      checkPromiseRef.current = checkPromise;
      try {
        await checkPromise;
      } finally {
        if (checkPromiseRef.current === checkPromise) {
          checkPromiseRef.current = null;
        }
      }
    },
    [downloadAndInstallUpdate, enabled, recordError, setStatusValue, t],
  );

  useEffect(() => {
    if (!enabled) {
      setStatusValue("unavailable");
      return;
    }

    if (statusRef.current === "unavailable") {
      setStatusValue("idle");
    }
  }, [enabled, setStatusValue]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (runStartupCheck) {
      void checkForUpdate({ background: true, quiet: true });
    }

    const interval = window.setInterval(() => {
      void checkForUpdate({ background: true, quiet: true });
    }, checkIntervalMs);

    return () => window.clearInterval(interval);
  }, [checkForUpdate, checkIntervalMs, enabled, runStartupCheck]);

  const value = useMemo<UpdaterContextValue>(
    () => ({
      status,
      enabled,
      availableVersion,
      downloadProgress,
      errorMessage,
      checkForUpdate,
      downloadAndInstall,
      relaunch,
    }),
    [
      status,
      enabled,
      availableVersion,
      downloadProgress,
      errorMessage,
      checkForUpdate,
      downloadAndInstall,
      relaunch,
    ],
  );

  return (
    <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>
  );
}

export function useUpdaterContext() {
  const context = useContext(UpdaterContext);
  if (!context) {
    throw new Error("useUpdaterContext must be used within UpdaterProvider");
  }
  return context;
}
