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
  forgetRemoteHost,
  isRemoteBackendError,
  listenRemoteBackendStatus,
  listRemoteBackends,
  listSshConfigHosts,
  shutdownRemoteHost,
  type RemoteBackendErrorLike,
  type RemoteBackendSnapshotEntry,
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
const MAX_RETIRED_INCARNATIONS_PER_HOST = 8;

export interface RemoteHostStatus {
  state: RemoteBackendState;
  incarnation?: string;
  generation?: number;
  attempt?: number;
  error?: RemoteBackendErrorLike;
}

export type RemoteHostConnectOutcome = "connected" | "superseded";

function backendStatus(
  payload: RemoteBackendStatusPayload | RemoteBackendSnapshotEntry,
): RemoteHostStatus {
  return {
    state: payload.state,
    incarnation: payload.incarnation,
    generation: payload.generation,
    ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
    ...(payload.error ? { error: payload.error } : {}),
  };
}

function acceptsBackendStatus(
  current: RemoteHostStatus | undefined,
  retiredIncarnations: string[] | undefined,
  payload: RemoteBackendStatusPayload | RemoteBackendSnapshotEntry,
): boolean {
  if (retiredIncarnations?.includes(payload.incarnation)) return false;
  if (!current?.incarnation) return true;
  return (
    current.incarnation === payload.incarnation &&
    (current.generation ?? 0) <= payload.generation
  );
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
  /** Successful Forget tombstones, cleared only by an explicit new connect. */
  forgottenHosts: Record<string, true>;
  /** Monotonic local lifecycle used to reject snapshots admitted before a change. */
  lifecycleByHost: Record<string, number>;
  /** Explicit connect lifecycle currently awaiting its backend result. */
  connectPendingLifecycleByHost: Record<string, number>;
  /** Forgotten backend slot identities that must never be admitted again. */
  retiredIncarnationsByHost: Record<string, string[]>;
  forgetPendingByHost: Record<string, boolean>;
  forgetErrorByHost: Record<string, RemoteBackendErrorLike | undefined>;
  recentDirsByHost: Record<string, string[]>;
  /** Per-host goose binary override; absent means the remote login PATH. */
  goosePathByHost: Record<string, string>;

  // Actions
  refreshConfigHosts: () => Promise<void>;
  syncBackendSnapshot: () => Promise<void>;
  applyStatusEvent: (payload: RemoteBackendStatusPayload) => void;
  /** Connect the host and report whether this exact lifecycle became current. */
  ensureHostConnected: (host: string) => Promise<RemoteHostConnectOutcome>;
  disconnect: (host: string) => Promise<void>;
  shutdownHost: (host: string, expectedInstanceToken?: string) => Promise<void>;
  runDoctor: (host: string) => Promise<void>;
  recordRecentDir: (host: string, dir: string) => void;
  forgetHost: (host: string) => Promise<void>;
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
  forgottenHosts: {},
  lifecycleByHost: {},
  connectPendingLifecycleByHost: {},
  retiredIncarnationsByHost: {},
  forgetPendingByHost: {},
  forgetErrorByHost: {},
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
    // Keep the lifecycle object from admission time. Store updates replace it,
    // so a Forget or explicit reconnect while IPC is in flight is observable.
    const lifecycleAtStart = get().lifecycleByHost;
    try {
      const snapshot = await listRemoteBackends();
      set((state) => {
        const statusByHost = { ...state.statusByHost };
        for (const entry of snapshot) {
          if (
            state.forgottenHosts[entry.host] ||
            state.connectPendingLifecycleByHost[entry.host] !== undefined ||
            (state.lifecycleByHost[entry.host] ?? 0) !==
              (lifecycleAtStart[entry.host] ?? 0) ||
            !acceptsBackendStatus(
              statusByHost[entry.host],
              state.retiredIncarnationsByHost[entry.host],
              entry,
            )
          ) {
            continue;
          }
          statusByHost[entry.host] = backendStatus(entry);
        }
        return { statusByHost };
      });
    } catch (error) {
      console.warn("Failed to list remote backends", error);
    }
  },

  applyStatusEvent: (payload) => {
    set((state) => {
      if (
        state.forgottenHosts[payload.host] ||
        state.connectPendingLifecycleByHost[payload.host] !== undefined ||
        !acceptsBackendStatus(
          state.statusByHost[payload.host],
          state.retiredIncarnationsByHost[payload.host],
          payload,
        )
      ) {
        return state;
      }
      return {
        statusByHost: {
          ...state.statusByHost,
          [payload.host]: backendStatus(payload),
        },
      };
    });
  },

  ensureHostConnected: async (host) => {
    let current = get();
    if (
      current.statusByHost[host]?.state === "ready" &&
      !current.forgottenHosts[host]
    ) {
      // A manually entered host can already be ready when it was restored
      // from the backend snapshot. Remember it even though no new connect is
      // required, otherwise it disappears from the selector after restart.
      let accepted = false;
      set((state) => {
        if (
          state.statusByHost[host]?.state !== "ready" ||
          state.forgottenHosts[host]
        ) {
          return state;
        }
        accepted = true;
        if (
          state.configHosts.includes(host) ||
          state.manualHosts.includes(host)
        ) {
          return state;
        }
        const manualHosts = [host, ...state.manualHosts].slice(
          0,
          MAX_MANUAL_HOSTS,
        );
        persistManualHosts(manualHosts);
        return { manualHosts };
      });
      if (accepted) return "connected";
      current = get();
    }

    // An explicit connection starts a new local lifecycle. This is the only
    // operation that clears a successful Forget tombstone.
    const lifecycle = (current.lifecycleByHost[host] ?? 0) + 1;
    set((state) => {
      const forgottenHosts = { ...state.forgottenHosts };
      const forgetErrorByHost = { ...state.forgetErrorByHost };
      const currentStatus = state.statusByHost[host];
      delete forgottenHosts[host];
      delete forgetErrorByHost[host];
      return {
        forgottenHosts,
        forgetErrorByHost,
        lifecycleByHost: {
          ...state.lifecycleByHost,
          [host]: lifecycle,
        },
        connectPendingLifecycleByHost: {
          ...state.connectPendingLifecycleByHost,
          [host]: lifecycle,
        },
        // Optimistic: Rust serializes concurrent connects per host, but the UI
        // should reflect the user's new lifecycle immediately.
        statusByHost: {
          ...state.statusByHost,
          [host]: {
            state: "connecting",
            ...(currentStatus?.incarnation
              ? {
                  incarnation: currentStatus.incarnation,
                  generation: currentStatus.generation,
                }
              : {}),
          },
        },
      };
    });
    try {
      const connection = await connectRemoteHost(host);
      let accepted = false;
      set((state) => {
        if (
          state.forgottenHosts[host] ||
          state.lifecycleByHost[host] !== lifecycle ||
          state.connectPendingLifecycleByHost[host] !== lifecycle
        ) {
          return state;
        }
        accepted = true;
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
        const connectPendingLifecycleByHost = {
          ...state.connectPendingLifecycleByHost,
        };
        delete connectPendingLifecycleByHost[host];
        return {
          manualHosts,
          connectPendingLifecycleByHost,
          statusByHost: {
            ...state.statusByHost,
            [host]: {
              state: "ready",
              incarnation: connection.incarnation,
              generation: connection.generation,
            },
          },
        };
      });
      return accepted ? "connected" : "superseded";
    } catch (error) {
      let accepted = false;
      set((state) => {
        if (
          state.forgottenHosts[host] ||
          state.lifecycleByHost[host] !== lifecycle ||
          state.connectPendingLifecycleByHost[host] !== lifecycle
        ) {
          return state;
        }
        accepted = true;
        const connectPendingLifecycleByHost = {
          ...state.connectPendingLifecycleByHost,
        };
        delete connectPendingLifecycleByHost[host];
        return {
          connectPendingLifecycleByHost,
          statusByHost: {
            ...state.statusByHost,
            [host]: {
              state: "failed",
              ...(state.statusByHost[host]?.incarnation
                ? {
                    incarnation: state.statusByHost[host].incarnation,
                    generation: state.statusByHost[host].generation,
                  }
                : {}),
              error: toRemoteBackendError(error),
            },
          },
        };
      });
      if (!accepted) return "superseded";
      throw error;
    }
  },

  disconnect: async (host) => {
    const admitted = get();
    const admittedLifecycle = admitted.lifecycleByHost[host] ?? 0;
    const admittedStatus = admitted.statusByHost[host];
    await disconnectRemoteHost(host, admittedStatus?.generation);
    set((state) => {
      const currentStatus = state.statusByHost[host];
      if (
        (state.lifecycleByHost[host] ?? 0) !== admittedLifecycle ||
        currentStatus?.incarnation !== admittedStatus?.incarnation ||
        currentStatus?.generation !== admittedStatus?.generation
      ) {
        return state;
      }
      return {
        statusByHost: {
          ...state.statusByHost,
          [host]: { ...currentStatus, state: "disconnected" },
        },
      };
    });
  },

  shutdownHost: async (host, expectedInstanceToken) => {
    const admitted = get();
    const admittedLifecycle = admitted.lifecycleByHost[host] ?? 0;
    const admittedStatus = admitted.statusByHost[host];
    await shutdownRemoteHost(
      host,
      expectedInstanceToken,
      admittedStatus?.generation,
    );
    set((state) => {
      const currentStatus = state.statusByHost[host];
      if (
        (state.lifecycleByHost[host] ?? 0) !== admittedLifecycle ||
        currentStatus?.incarnation !== admittedStatus?.incarnation ||
        currentStatus?.generation !== admittedStatus?.generation
      ) {
        return state;
      }
      return {
        statusByHost: {
          ...state.statusByHost,
          [host]: { ...currentStatus, state: "disconnected" },
        },
      };
    });
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

  forgetHost: async (host) => {
    if (get().forgetPendingByHost[host]) return;
    const admittedLifecycle = get().lifecycleByHost[host] ?? 0;
    set((state) => ({
      forgetPendingByHost: {
        ...state.forgetPendingByHost,
        [host]: true,
      },
      forgetErrorByHost: {
        ...state.forgetErrorByHost,
        [host]: undefined,
      },
    }));
    try {
      await forgetRemoteHost(host);
    } catch (error) {
      set((state) => {
        const forgetPendingByHost = {
          ...state.forgetPendingByHost,
          [host]: false,
        };
        const forgetErrorByHost = { ...state.forgetErrorByHost };
        if ((state.lifecycleByHost[host] ?? 0) === admittedLifecycle) {
          forgetErrorByHost[host] = toRemoteBackendError(error);
        } else {
          delete forgetErrorByHost[host];
        }
        return { forgetPendingByHost, forgetErrorByHost };
      });
      throw error;
    }
    set((state) => {
      const forgetPendingByHost = { ...state.forgetPendingByHost };
      delete forgetPendingByHost[host];
      if ((state.lifecycleByHost[host] ?? 0) !== admittedLifecycle) {
        // A newer explicit Connect owns this row. The old Forget result may
        // clear its own pending marker, but must not erase the replacement.
        return { forgetPendingByHost };
      }
      const manualHosts = state.manualHosts.filter(
        (candidate) => candidate !== host,
      );
      const statusByHost = { ...state.statusByHost };
      const doctorByHost = { ...state.doctorByHost };
      const doctorPendingByHost = { ...state.doctorPendingByHost };
      const doctorErrorByHost = { ...state.doctorErrorByHost };
      const forgottenHosts = { ...state.forgottenHosts, [host]: true as const };
      const connectPendingLifecycleByHost = {
        ...state.connectPendingLifecycleByHost,
      };
      const retiredIncarnationsByHost = {
        ...state.retiredIncarnationsByHost,
      };
      const forgetErrorByHost = { ...state.forgetErrorByHost };
      const forgottenIncarnation = statusByHost[host]?.incarnation;
      if (forgottenIncarnation) {
        retiredIncarnationsByHost[host] = [
          forgottenIncarnation,
          ...(retiredIncarnationsByHost[host] ?? []).filter(
            (candidate) => candidate !== forgottenIncarnation,
          ),
        ].slice(0, MAX_RETIRED_INCARNATIONS_PER_HOST);
      }
      delete statusByHost[host];
      delete doctorByHost[host];
      delete doctorPendingByHost[host];
      delete doctorErrorByHost[host];
      delete forgetErrorByHost[host];
      delete connectPendingLifecycleByHost[host];
      persistManualHosts(manualHosts);
      return {
        manualHosts,
        statusByHost,
        doctorByHost,
        doctorPendingByHost,
        doctorErrorByHost,
        forgottenHosts,
        lifecycleByHost: {
          ...state.lifecycleByHost,
          [host]: (state.lifecycleByHost[host] ?? 0) + 1,
        },
        connectPendingLifecycleByHost,
        retiredIncarnationsByHost,
        forgetPendingByHost,
        forgetErrorByHost,
      };
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
  return useRemoteHostStore
    .getState()
    .ensureHostConnected(host)
    .then(() => undefined);
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
