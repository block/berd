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
import type { Update as TauriUpdate } from "@tauri-apps/plugin-updater";
import { Update as TauriUpdateResource } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { probeKgooseConnectivity } from "@/shared/api/connectivity";

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

export interface ReleaseChannelInfo {
  id: string;
  label: string;
  description?: string;
}

export interface CompatibilityDescriptor {
  storeContractVersion: number;
  writesDataEpoch: number;
  minReadableDataEpoch: number;
  maxReadableDataEpoch: number;
}

export interface RunningBuildInfo {
  channelId: string;
  version: string;
  compatibility: CompatibilityDescriptor;
  whatToTest?: string;
}

export interface PendingInstall {
  transitionId: string;
  sourceChannelId: string;
  targetChannelId: string;
  targetVersion: string;
  targetArtifactSha256: string;
  targetCompatibility: CompatibilityDescriptor;
  installed: boolean;
}

export interface WaitingForMain {
  sourceChannelId: string;
  targetChannelId: string;
}

export interface ReleaseRuntime {
  enabled: boolean;
  channels: ReleaseChannelInfo[];
  defaultChannelId?: string;
  selectedFeed?: string;
  runningBuild?: RunningBuildInfo;
  pendingInstall?: PendingInstall;
  waitingForMain?: WaitingForMain;
  notice?: string;
}

export interface PreparedChannelSwitch {
  channelId: string;
  channelLabel: string;
  version: string;
  currentVersion: string;
  body?: string;
}

type ReleaseUpdateMetadata = {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
  targetChannelId: string;
  targetChannelLabel: string;
};

type CheckForUpdateOptions = {
  background?: boolean;
  quiet?: boolean;
};

type UpdaterContextValue = {
  status: UpdateStatus;
  enabled: boolean;
  runtime: ReleaseRuntime;
  availableVersion: string | null;
  downloadProgress: number | null;
  errorMessage: string | null;
  errorDetail: string | null;
  preparedSwitch: PreparedChannelSwitch | null;
  waitingMessage: string | null;
  checkForUpdate: (options?: CheckForUpdateOptions) => Promise<void>;
  prepareChannelSwitch: (channelId: string) => Promise<void>;
  cancelPreparedSwitch: () => void;
  confirmPreparedSwitch: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  relaunch: () => Promise<void>;
};

type UpdaterProviderProps = {
  children: ReactNode;
  checkIntervalMs?: number;
  runStartupCheck?: boolean;
};

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ACTIVE_UPDATE_STATUSES = new Set<UpdateStatus>([
  "available",
  "downloading",
  "installing",
  "ready",
]);
const DISABLED_RUNTIME: ReleaseRuntime = {
  enabled: false,
  channels: [],
};

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

const PREVIEW_COMPATIBILITY: CompatibilityDescriptor = {
  storeContractVersion: 1,
  writesDataEpoch: 2,
  minReadableDataEpoch: 1,
  maxReadableDataEpoch: 2,
};

function previewRuntimeFromQuery(): ReleaseRuntime | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const preview =
    new URLSearchParams(window.location.search).get("releaseChannelPreview") ??
    import.meta.env.VITE_RELEASE_CHANNEL_PREVIEW;
  if (preview !== "main" && preview !== "beta") return null;
  return {
    enabled: true,
    channels: [
      { id: "main", label: "Main", description: "Recommended releases" },
      { id: "beta", label: "Beta", description: "New features first" },
    ],
    defaultChannelId: "main",
    selectedFeed: preview,
    runningBuild: {
      channelId: preview,
      version: import.meta.env.VITE_APP_VERSION ?? "preview",
      compatibility: PREVIEW_COMPATIBILITY,
      whatToTest:
        preview === "beta"
          ? "Try the newest features and report anything that feels rough."
          : undefined,
    },
  };
}

function updateFromMetadata(metadata: ReleaseUpdateMetadata): TauriUpdate {
  return new TauriUpdateResource(metadata);
}

export function UpdaterProvider({
  children,
  checkIntervalMs = CHECK_INTERVAL_MS,
  runStartupCheck = true,
}: UpdaterProviderProps) {
  const { t } = useTranslation("settings");
  const previewRuntime = useMemo(previewRuntimeFromQuery, []);
  const nativeUpdaterEnabled = isUpdaterEnabled();
  const enabled = nativeUpdaterEnabled || previewRuntime !== null;
  const [runtime, setRuntime] = useState<ReleaseRuntime>(
    previewRuntime ?? DISABLED_RUNTIME,
  );
  const [status, setStatus] = useState<UpdateStatus>(
    previewRuntime ? "idle" : initialStatus,
  );
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [preparedSwitch, setPreparedSwitch] =
    useState<PreparedChannelSwitch | null>(null);
  const [waitingMessage, setWaitingMessage] = useState<string | null>(null);

  const statusRef = useRef<UpdateStatus>(status);
  const updateRef = useRef<TauriUpdate | null>(null);
  const updateRidRef = useRef<number | null>(null);
  const switchUpdateRef = useRef<TauriUpdate | null>(null);
  const switchUpdateRidRef = useRef<number | null>(null);
  const checkPromiseRef = useRef<Promise<void> | null>(null);
  const installPromiseRef = useRef<Promise<void> | null>(null);

  const setStatusValue = useCallback((nextStatus: UpdateStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const clearErrors = useCallback(() => {
    setErrorMessage(null);
    setErrorDetail(null);
  }, []);

  const recordError = useCallback(
    (error: unknown, fallbackMessage = t("updates.errors.generic")) => {
      const detail = getErrorMessage(error);
      console.warn(`[updater] ${detail}`);
      setErrorMessage(fallbackMessage);
      setErrorDetail(detail || null);
      setStatusValue("error");
      toast.error(t("updates.toast.error.title"), {
        description: t("updates.toast.error.description", {
          message: fallbackMessage,
        }),
      });
    },
    [setStatusValue, t],
  );

  const refreshRuntime = useCallback(async () => {
    if (previewRuntime) {
      setRuntime(previewRuntime);
      return previewRuntime;
    }
    if (!nativeUpdaterEnabled) {
      setRuntime(DISABLED_RUNTIME);
      return DISABLED_RUNTIME;
    }
    const nextRuntime = await invoke<ReleaseRuntime>("get_release_runtime");
    setRuntime(nextRuntime);
    return nextRuntime;
  }, [nativeUpdaterEnabled, previewRuntime]);

  const relaunch = useCallback(async () => {
    if (!enabled) {
      setStatusValue("unavailable");
      return;
    }

    try {
      try {
        if (await invoke<boolean>("finalize_update_relaunch")) {
          return;
        }
      } catch (error) {
        console.warn(
          `[updater] legacy bundle rename skipped: ${getErrorMessage(error)}`,
        );
      }
      const { relaunch: restartApp } = await import(
        "@tauri-apps/plugin-process"
      );
      await restartApp();
    } catch (error) {
      recordError(error);
    }
  }, [enabled, recordError, setStatusValue]);

  const clearPendingSwitch = useCallback(async (transitionId?: string) => {
    if (!transitionId) return;
    try {
      const nextRuntime = await invoke<ReleaseRuntime>(
        "cancel_channel_switch",
        { request: { transitionId } },
      );
      setRuntime(nextRuntime);
    } catch (error) {
      console.warn(
        `[updater] failed to clear channel transition: ${getErrorMessage(error)}`,
      );
    }
  }, []);

  const downloadAndInstallUpdate = useCallback(
    async (rid: number, transitionId?: string) => {
      if (installPromiseRef.current) {
        return installPromiseRef.current;
      }

      const installPromise = (async () => {
        clearErrors();
        setDownloadProgress(null);
        setStatusValue("downloading");

        try {
          const nextRuntime = await invoke<ReleaseRuntime>(
            "download_and_install_release",
            { rid, transitionId: transitionId ?? null },
          );
          setRuntime(nextRuntime);
          setDownloadProgress(100);
          setStatusValue("ready");
        } catch (error) {
          await clearPendingSwitch(transitionId);
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
    [clearErrors, clearPendingSwitch, recordError, setStatusValue],
  );

  const downloadAndInstall = useCallback(async () => {
    if (!enabled) {
      setStatusValue("unavailable");
      return;
    }
    const update = updateRef.current;
    const rid = updateRidRef.current;
    if (update && rid != null) {
      await downloadAndInstallUpdate(rid);
    }
  }, [downloadAndInstallUpdate, enabled, setStatusValue]);

  const handleCheckError = useCallback(
    async (error: unknown, options: CheckForUpdateOptions) => {
      if (options.quiet) {
        console.warn(`[updater] check failed: ${getErrorMessage(error)}`);
        setStatusValue("idle");
        return;
      }
      const probe = await probeKgooseConnectivity();
      recordError(
        error,
        probe?.likelyWarpFailure
          ? t("updates.errors.networkAccess")
          : t("updates.errors.generic"),
      );
    },
    [recordError, setStatusValue, t],
  );

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
        if (options.background) return;
        return (
          checkPromiseRef.current ?? installPromiseRef.current ?? undefined
        );
      }
      if (checkPromiseRef.current) return checkPromiseRef.current;

      const checkPromise = (async () => {
        clearErrors();
        setDownloadProgress(null);
        setStatusValue("checking");
        try {
          const metadata = await invoke<ReleaseUpdateMetadata | null>(
            "check_release_update",
          );
          if (!metadata) {
            updateRef.current = null;
            setAvailableVersion(null);
            setStatusValue("up-to-date");
            return;
          }
          const update = updateFromMetadata(metadata);
          updateRef.current = update;
          updateRidRef.current = metadata.rid;
          setAvailableVersion(update.version);
          setStatusValue("available");
          await downloadAndInstallUpdate(metadata.rid);
        } catch (error) {
          await handleCheckError(error, options);
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
    [
      clearErrors,
      downloadAndInstallUpdate,
      enabled,
      handleCheckError,
      setStatusValue,
    ],
  );

  const prepareChannelSwitch = useCallback(
    async (channelId: string) => {
      if (previewRuntime) {
        const target = previewRuntime.channels.find(
          (channel) => channel.id === channelId,
        );
        if (!target || channelId === previewRuntime.runningBuild?.channelId) {
          return;
        }
        setPreparedSwitch({
          channelId,
          channelLabel: target.label,
          version: "preview-target",
          currentVersion: previewRuntime.runningBuild?.version ?? "preview",
        });
        return;
      }
      if (!enabled || channelId === runtime.runningBuild?.channelId) return;
      if (checkPromiseRef.current || installPromiseRef.current) return;

      const checkPromise = (async () => {
        clearErrors();
        setWaitingMessage(null);
        setStatusValue("checking");
        try {
          const metadata = await invoke<ReleaseUpdateMetadata | null>(
            "prepare_channel_switch",
            { request: { channelId } },
          );
          if (!metadata) {
            throw new Error(
              t("updates.errors.switchUnavailable", {
                channel: runtime.channels.find(
                  (channel) => channel.id === channelId,
                )?.label,
              }),
            );
          }
          switchUpdateRef.current = updateFromMetadata(metadata);
          switchUpdateRidRef.current = metadata.rid;
          setPreparedSwitch({
            channelId: metadata.targetChannelId,
            channelLabel: metadata.targetChannelLabel,
            version: metadata.version,
            currentVersion: metadata.currentVersion,
            body: metadata.body,
          });
          setStatusValue("idle");
        } catch (error) {
          await handleCheckError(error, {});
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
    [
      clearErrors,
      enabled,
      handleCheckError,
      previewRuntime,
      runtime.channels,
      runtime.runningBuild?.channelId,
      setStatusValue,
      t,
    ],
  );

  const cancelPreparedSwitch = useCallback(() => {
    setPreparedSwitch(null);
    switchUpdateRef.current = null;
    switchUpdateRidRef.current = null;
  }, []);

  const confirmPreparedSwitch = useCallback(async () => {
    const prepared = preparedSwitch;
    if (previewRuntime) {
      setPreparedSwitch(null);
      return;
    }
    const update = switchUpdateRef.current;
    const rid = switchUpdateRidRef.current;
    if (!prepared || !update || rid == null) return;
    try {
      clearErrors();
      const result = await invoke<{
        runtime: ReleaseRuntime;
        waitingMessage?: string;
      }>("confirm_channel_switch", {
        request: {
          channelId: prepared.channelId,
          version: prepared.version,
        },
      });
      setRuntime(result.runtime);
      setPreparedSwitch(null);
      switchUpdateRef.current = null;
      switchUpdateRidRef.current = null;
      if (result.waitingMessage) {
        setWaitingMessage(result.waitingMessage);
        setStatusValue("idle");
        return;
      }
      const transitionId = result.runtime.pendingInstall?.transitionId;
      if (!transitionId) {
        throw new Error("Berd could not record the release switch safely.");
      }
      setAvailableVersion(prepared.version);
      await downloadAndInstallUpdate(rid, transitionId);
    } catch (error) {
      recordError(error);
    }
  }, [
    clearErrors,
    downloadAndInstallUpdate,
    preparedSwitch,
    previewRuntime,
    recordError,
    setStatusValue,
  ]);

  useEffect(() => {
    if (!enabled) {
      setRuntime(DISABLED_RUNTIME);
      setStatusValue("unavailable");
      return;
    }
    let cancelled = false;
    void refreshRuntime()
      .then((nextRuntime) => {
        if (!cancelled && nextRuntime.pendingInstall?.installed) {
          setAvailableVersion(nextRuntime.pendingInstall.targetVersion);
          setStatusValue("ready");
        }
      })
      .catch((error) => {
        if (!cancelled) recordError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, recordError, refreshRuntime, setStatusValue]);

  useEffect(() => {
    if (!nativeUpdaterEnabled) return;
    if (runStartupCheck) {
      void checkForUpdate({ background: true, quiet: true });
    }
    const interval = window.setInterval(() => {
      void checkForUpdate({ background: true, quiet: true });
    }, checkIntervalMs);
    return () => window.clearInterval(interval);
  }, [checkForUpdate, checkIntervalMs, nativeUpdaterEnabled, runStartupCheck]);

  const value = useMemo<UpdaterContextValue>(
    () => ({
      status,
      enabled: enabled && runtime.enabled,
      runtime,
      availableVersion,
      downloadProgress,
      errorMessage,
      errorDetail,
      preparedSwitch,
      waitingMessage,
      checkForUpdate,
      prepareChannelSwitch,
      cancelPreparedSwitch,
      confirmPreparedSwitch,
      downloadAndInstall,
      relaunch,
    }),
    [
      status,
      enabled,
      runtime,
      availableVersion,
      downloadProgress,
      errorMessage,
      errorDetail,
      preparedSwitch,
      waitingMessage,
      checkForUpdate,
      prepareChannelSwitch,
      cancelPreparedSwitch,
      confirmPreparedSwitch,
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
