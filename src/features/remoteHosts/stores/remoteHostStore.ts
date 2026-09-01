import { create } from "zustand";
import {
  isValidGoosePath,
  loadPersistedGoosePaths,
  persistGoosePaths,
} from "@/features/remoteHosts/lib/gooseBinaryOverride";
import {
  checkRemoteHost,
  connectRemoteHost,
  disconnectRemoteHost,
  isRemoteBackendError,
  listenRemoteBackendStatus,
  listRemoteBackends,
  listSshConfigHosts,
  shutdownRemoteHost,
  type RemoteBackendErrorLike,
  type RemoteBackendState,
  type RemoteBackendStatusPayload,
  type RemoteToolProbe,
} from "@/shared/api/remoteHosts";

export const REMOTE_HOST_RECENT_DIRS_STORAGE_KEY =
  "goose:remote-host-recent-dirs";
export const REMOTE_HOST_MANUAL_HOSTS_STORAGE_KEY =
  "goose:remote-host-manual-hosts";

const MAX_RECENT_DIRS_PER_HOST = 8;
const MAX_MANUAL_HOSTS = 16;

export interface RemoteHostStatus {
  state: RemoteBackendState;
  attempt?: number;
  error?: RemoteBackendErrorLike;
}

function toRemoteBackendError(error: unknown): RemoteBackendErrorLike {
  if (isRemoteBackendError(error)) return error;
  return {
    kind: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Recent remote directories by host, persisted in localStorage. Paths and
 *  hostnames only — never secrets. */
export function loadPersistedRecentDirs(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(
      REMOTE_HOST_RECENT_DIRS_STORAGE_KEY,
    );
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const byHost: Record<string, string[]> = {};
    for (const [host, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const dirs = value
        .filter((dir): dir is string => typeof dir === "string" && dir !== "")
        .slice(0, MAX_RECENT_DIRS_PER_HOST);
      if (dirs.length > 0) {
        byHost[host] = dirs;
      }
    }
    return byHost;
  } catch {
    return {};
  }
}

function persistRecentDirs(byHost: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      REMOTE_HOST_RECENT_DIRS_STORAGE_KEY,
      JSON.stringify(byHost),
    );
  } catch {
    // localStorage may be unavailable
  }
}

/** Hosts the user typed in manually (not in ~/.ssh/config), persisted so
 *  they survive restarts. Hostnames only — never secrets. */
export function loadPersistedManualHosts(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(
      REMOTE_HOST_MANUAL_HOSTS_STORAGE_KEY,
    );
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (host): host is string =>
          typeof host === "string" && host.trim() !== "",
      )
      .slice(0, MAX_MANUAL_HOSTS);
  } catch {
    return [];
  }
}

function persistManualHosts(hosts: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      REMOTE_HOST_MANUAL_HOSTS_STORAGE_KEY,
      JSON.stringify(hosts),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export interface RemoteHostStore {
  /** Concrete Host aliases from ~/.ssh/config. */
  configHosts: string[];
  /** Hosts the user added manually (persisted across restarts). */
  manualHosts: string[];
  statusByHost: Record<string, RemoteHostStatus>;
  doctorByHost: Record<string, RemoteToolProbe[] | undefined>;
  doctorPendingByHost: Record<string, boolean>;
  doctorErrorByHost: Record<string, RemoteBackendErrorLike | undefined>;
  recentDirsByHost: Record<string, string[]>;
  /** Per-host goose binary override; absent means the remote login PATH. */
  goosePathByHost: Record<string, string>;

  // Actions
  refreshConfigHosts: () => Promise<void>;
  syncBackendSnapshot: () => Promise<void>;
  applyStatusEvent: (payload: RemoteBackendStatusPayload) => void;
  ensureHostConnected: (host: string) => Promise<void>;
  disconnect: (host: string) => Promise<void>;
  shutdownHost: (host: string, expectedInstanceToken?: string) => Promise<void>;
  runDoctor: (host: string) => Promise<void>;
  recordRecentDir: (host: string, dir: string) => void;
  removeManualHost: (host: string) => void;
  /**
   * Set (or clear, with `null`) the goose binary a host's remote backend
   * should run. Returns false for a path the remote script could not resolve.
   * Takes effect on the next connect, which restarts the remote daemon.
   */
  setGoosePath: (host: string, path: string | null) => boolean;
}

export const useRemoteHostStore = create<RemoteHostStore>((set, get) => ({
  configHosts: [],
  manualHosts: loadPersistedManualHosts(),
  statusByHost: {},
  doctorByHost: {},
  doctorPendingByHost: {},
  doctorErrorByHost: {},
  recentDirsByHost: loadPersistedRecentDirs(),
  goosePathByHost: loadPersistedGoosePaths(),

  refreshConfigHosts: async () => {
    try {
      const configHosts = await listSshConfigHosts();
      set({ configHosts });
    } catch (error) {
      // Keep the previous list; the SSH config may be temporarily unreadable.
      console.warn("Failed to list SSH config hosts", error);
    }
  },

  syncBackendSnapshot: async () => {
    try {
      const snapshot = await listRemoteBackends();
      set((state) => {
        const statusByHost = { ...state.statusByHost };
        for (const entry of snapshot) {
          statusByHost[entry.host] = {
            state: entry.state,
            ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
            ...(entry.error ? { error: entry.error } : {}),
          };
        }
        return { statusByHost };
      });
    } catch (error) {
      console.warn("Failed to list remote backends", error);
    }
  },

  applyStatusEvent: (payload) => {
    set((state) => ({
      statusByHost: {
        ...state.statusByHost,
        [payload.host]: {
          state: payload.state,
          ...(payload.attempt !== undefined
            ? { attempt: payload.attempt }
            : {}),
          ...(payload.error ? { error: payload.error } : {}),
        },
      },
    }));
  },

  ensureHostConnected: async (host) => {
    if (get().statusByHost[host]?.state === "ready") return;

    // Optimistic: the Rust side serializes concurrent connects per host and
    // emits status events, but reflect intent immediately in the UI.
    set((state) => ({
      statusByHost: {
        ...state.statusByHost,
        [host]: { state: "connecting" },
      },
    }));
    try {
      await connectRemoteHost(host);
      set((state) => {
        // A host that connected but isn't in ~/.ssh/config was typed in
        // manually; remember it across restarts.
        const isKnown =
          state.configHosts.includes(host) || state.manualHosts.includes(host);
        const manualHosts = isKnown
          ? state.manualHosts
          : [host, ...state.manualHosts].slice(0, MAX_MANUAL_HOSTS);
        if (!isKnown) {
          persistManualHosts(manualHosts);
        }
        return {
          manualHosts,
          statusByHost: {
            ...state.statusByHost,
            [host]: { state: "ready" },
          },
        };
      });
    } catch (error) {
      set((state) => ({
        statusByHost: {
          ...state.statusByHost,
          [host]: { state: "failed", error: toRemoteBackendError(error) },
        },
      }));
      throw error;
    }
  },

  disconnect: async (host) => {
    await disconnectRemoteHost(host);
    set((state) => ({
      statusByHost: {
        ...state.statusByHost,
        [host]: { state: "disconnected" },
      },
    }));
  },

  shutdownHost: async (host, expectedInstanceToken) => {
    if (expectedInstanceToken) {
      await shutdownRemoteHost(host, expectedInstanceToken);
    } else {
      await shutdownRemoteHost(host);
    }
    set((state) => ({
      statusByHost: {
        ...state.statusByHost,
        [host]: { state: "disconnected" },
      },
    }));
  },

  runDoctor: async (host) => {
    set((state) => ({
      doctorPendingByHost: { ...state.doctorPendingByHost, [host]: true },
    }));
    try {
      const probes = await checkRemoteHost(host);
      set((state) => ({
        doctorByHost: { ...state.doctorByHost, [host]: probes },
        doctorErrorByHost: { ...state.doctorErrorByHost, [host]: undefined },
        doctorPendingByHost: { ...state.doctorPendingByHost, [host]: false },
      }));
    } catch (error) {
      set((state) => ({
        doctorErrorByHost: {
          ...state.doctorErrorByHost,
          [host]: toRemoteBackendError(error),
        },
        doctorPendingByHost: { ...state.doctorPendingByHost, [host]: false },
      }));
    }
  },

  removeManualHost: (host) => {
    set((state) => {
      if (!state.manualHosts.includes(host)) return state;
      const manualHosts = state.manualHosts.filter(
        (candidate) => candidate !== host,
      );
      persistManualHosts(manualHosts);
      return { manualHosts };
    });
  },

  setGoosePath: (host, path) => {
    const trimmedHost = host.trim();
    if (!trimmedHost) return false;
    const trimmedPath = path?.trim() ?? "";
    if (path !== null && !isValidGoosePath(trimmedPath)) return false;

    set((state) => {
      const goosePathByHost = { ...state.goosePathByHost };
      if (path === null) {
        delete goosePathByHost[trimmedHost];
      } else {
        goosePathByHost[trimmedHost] = trimmedPath;
      }
      persistGoosePaths(goosePathByHost);
      return { goosePathByHost };
    });
    return true;
  },

  recordRecentDir: (host, dir) => {
    const trimmedHost = host.trim();
    const trimmedDir = dir.trim();
    if (!trimmedHost || !trimmedDir) return;

    set((state) => {
      const existing = state.recentDirsByHost[trimmedHost] ?? [];
      const dirs = [
        trimmedDir,
        ...existing.filter((candidate) => candidate !== trimmedDir),
      ].slice(0, MAX_RECENT_DIRS_PER_HOST);
      const recentDirsByHost = {
        ...state.recentDirsByHost,
        [trimmedHost]: dirs,
      };
      persistRecentDirs(recentDirsByHost);
      return { recentDirsByHost };
    });
  },
}));

/**
 * Module-level convenience wrapper over the store's `ensureHostConnected`
 * action for callers outside React (e.g. session routing in chat).
 */
export function ensureHostConnected(host: string): Promise<void> {
  return useRemoteHostStore.getState().ensureHostConnected(host);
}

let remoteHostStoreInitStarted = false;

/**
 * Start the live-status subscription and store seeding once per app lifetime.
 * Returns true when this call started it, false when it was already running —
 * callers that want fresher data on later invocations refresh explicitly.
 * Callers gate this behind the remote-ssh-sessions experiment.
 */
export function ensureRemoteHostStoreInitialized(): boolean {
  if (remoteHostStoreInitStarted) return false;
  remoteHostStoreInitStarted = true;
  void initRemoteHostStore();
  return true;
}

/**
 * Subscribe to remote backend status events and seed the store from the
 * backend snapshot and the SSH config. Returns an unsubscribe function.
 * Not wired into app startup here — callers gate it behind the
 * remote-ssh-sessions experiment.
 */
export async function initRemoteHostStore(): Promise<() => void> {
  const unlisten = await listenRemoteBackendStatus((payload) => {
    useRemoteHostStore.getState().applyStatusEvent(payload);
  });
  await Promise.all([
    useRemoteHostStore.getState().syncBackendSnapshot(),
    useRemoteHostStore.getState().refreshConfigHosts(),
  ]);
  return unlisten;
}
