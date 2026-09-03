import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteBackendConnection,
  RemoteBackendSnapshotEntry,
  RemoteToolProbe,
} from "@/shared/api/remoteHosts";

const mocks = vi.hoisted(() => ({
  listSshConfigHosts: vi.fn(),
  connectRemoteHost: vi.fn(),
  disconnectRemoteHost: vi.fn(),
  forgetRemoteHost: vi.fn(),
  shutdownRemoteHost: vi.fn(),
  listRemoteBackends: vi.fn(),
  checkRemoteHost: vi.fn(),
  listenRemoteBackendStatus: vi.fn(),
}));

vi.mock("@/shared/api/remoteHosts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/api/remoteHosts")>();
  return { ...actual, ...mocks };
});

import {
  getGoosePathForHost,
  loadPersistedGoosePaths,
  REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
} from "@/features/remoteHosts/lib/gooseBinaryOverride";
import {
  initRemoteHostStore,
  loadPersistedManualHosts,
  loadPersistedRecentDirs,
  REMOTE_HOST_MANUAL_HOSTS_STORAGE_KEY,
  REMOTE_HOST_RECENT_DIRS_STORAGE_KEY,
  useRemoteHostStore,
} from "./remoteHostStore";

const connection: RemoteBackendConnection = {
  wsUrl: "ws://127.0.0.1:4001/ws",
  httpBaseUrl: "http://127.0.0.1:4001",
  secretKey: "secret",
  localPort: 4001,
  gooseVersion: "1.2.3",
  daemonReused: false,
  incarnation: "slot-1",
  generation: 1,
};

const backendIdentity = {
  incarnation: connection.incarnation,
  generation: connection.generation,
};

function resetStore(): void {
  useRemoteHostStore.setState({
    configHosts: [],
    manualHosts: [],
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
    recentDirsByHost: {},
    goosePathByHost: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetStore();
  mocks.forgetRemoteHost.mockResolvedValue(undefined);
});

describe("applyStatusEvent", () => {
  it("updates statusByHost from status events", () => {
    useRemoteHostStore.getState().applyStatusEvent({
      host: "devbox",
      ...backendIdentity,
      state: "reconnecting",
      attempt: 2,
    });

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "reconnecting",
      attempt: 2,
    });
  });

  it("clears a previous error when a ready event arrives", () => {
    useRemoteHostStore.getState().applyStatusEvent({
      host: "devbox",
      ...backendIdentity,
      state: "failed",
      error: { kind: "host-unreachable", message: "no route" },
    });
    expect(
      useRemoteHostStore.getState().statusByHost.devbox.error,
    ).toBeDefined();

    useRemoteHostStore.getState().applyStatusEvent({
      host: "devbox",
      ...backendIdentity,
      state: "ready",
      wsUrl: connection.wsUrl,
      localPort: connection.localPort,
    });

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "ready",
    });
  });
});

describe("syncBackendSnapshot", () => {
  it("copies snapshot entries into statusByHost", async () => {
    mocks.listRemoteBackends.mockResolvedValue([
      { host: "devbox", ...backendIdentity, state: "ready" },
      {
        host: "broken",
        incarnation: "broken-slot",
        generation: 3,
        state: "failed",
        error: { kind: "auth-failed", message: "denied" },
      },
    ]);

    await useRemoteHostStore.getState().syncBackendSnapshot();

    const { statusByHost } = useRemoteHostStore.getState();
    expect(statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "ready",
    });
    expect(statusByHost.broken).toEqual({
      incarnation: "broken-slot",
      generation: 3,
      state: "failed",
      error: { kind: "auth-failed", message: "denied" },
    });
  });

  it("keeps the previous statuses when the snapshot fails", async () => {
    useRemoteHostStore
      .getState()
      .applyStatusEvent({ host: "devbox", ...backendIdentity, state: "ready" });
    mocks.listRemoteBackends.mockRejectedValue(new Error("ipc down"));

    await useRemoteHostStore.getState().syncBackendSnapshot();

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "ready",
    });
  });

  it("does not restore a forgotten host from an older in-flight snapshot", async () => {
    const host = "broken.blox";
    let resolveSnapshot: (snapshot: RemoteBackendSnapshotEntry[]) => void =
      () => {};
    mocks.listRemoteBackends.mockImplementation(
      () =>
        new Promise<RemoteBackendSnapshotEntry[]>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    useRemoteHostStore.setState({
      statusByHost: { [host]: { ...backendIdentity, state: "failed" } },
    });

    const syncing = useRemoteHostStore.getState().syncBackendSnapshot();
    await useRemoteHostStore.getState().forgetHost(host);
    resolveSnapshot([{ host, ...backendIdentity, state: "failed" }]);
    await syncing;

    expect(useRemoteHostStore.getState().statusByHost).not.toHaveProperty(host);
    expect(useRemoteHostStore.getState().forgottenHosts[host]).toBe(true);
  });

  it("rejects a pre-forget snapshot after an intentional reconnect", async () => {
    const host = "broken.blox";
    let resolveSnapshot: (snapshot: RemoteBackendSnapshotEntry[]) => void =
      () => {};
    mocks.listRemoteBackends.mockImplementation(
      () =>
        new Promise<RemoteBackendSnapshotEntry[]>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const replacementConnection = {
      ...connection,
      incarnation: "slot-2",
    };
    mocks.connectRemoteHost.mockResolvedValue(replacementConnection);
    useRemoteHostStore.setState({
      statusByHost: { [host]: { ...backendIdentity, state: "failed" } },
    });

    const syncing = useRemoteHostStore.getState().syncBackendSnapshot();
    await useRemoteHostStore.getState().forgetHost(host);
    await useRemoteHostStore.getState().ensureHostConnected(host);
    resolveSnapshot([{ host, ...backendIdentity, state: "disconnected" }]);
    await syncing;

    expect(useRemoteHostStore.getState().statusByHost[host]).toEqual({
      incarnation: replacementConnection.incarnation,
      generation: replacementConnection.generation,
      state: "ready",
    });
    expect(useRemoteHostStore.getState().forgottenHosts[host]).toBeUndefined();
  });
});

describe("refreshConfigHosts", () => {
  it("keeps the old list when listing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.listSshConfigHosts.mockResolvedValue(["devbox", "gpu-1"]);
    await useRemoteHostStore.getState().refreshConfigHosts();
    expect(useRemoteHostStore.getState().configHosts).toEqual([
      "devbox",
      "gpu-1",
    ]);

    mocks.listSshConfigHosts.mockRejectedValue(new Error("no config"));
    await useRemoteHostStore.getState().refreshConfigHosts();

    expect(useRemoteHostStore.getState().configHosts).toEqual([
      "devbox",
      "gpu-1",
    ]);
    warn.mockRestore();
  });
});

describe("ensureHostConnected", () => {
  it("resolves without invoking connect when the host is already ready", async () => {
    useRemoteHostStore
      .getState()
      .applyStatusEvent({ host: "devbox", ...backendIdentity, state: "ready" });

    await useRemoteHostStore.getState().ensureHostConnected("devbox");

    expect(mocks.connectRemoteHost).not.toHaveBeenCalled();
  });

  it("remembers a manually entered host when its backend is already ready", async () => {
    useRemoteHostStore.setState({ configHosts: ["configured"] });
    useRemoteHostStore.getState().applyStatusEvent({
      host: "workstation.blox",
      ...backendIdentity,
      state: "ready",
    });

    await useRemoteHostStore.getState().ensureHostConnected("workstation.blox");

    expect(mocks.connectRemoteHost).not.toHaveBeenCalled();
    expect(useRemoteHostStore.getState().manualHosts).toEqual([
      "workstation.blox",
    ]);
    expect(loadPersistedManualHosts()).toEqual(["workstation.blox"]);
  });

  it("connects and marks the host ready", async () => {
    let resolveConnect: (value: RemoteBackendConnection) => void = () => {};
    mocks.connectRemoteHost.mockImplementation(
      () =>
        new Promise<RemoteBackendConnection>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const pending = useRemoteHostStore.getState().ensureHostConnected("devbox");
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "connecting",
    });

    resolveConnect(connection);
    await pending;

    expect(mocks.connectRemoteHost).toHaveBeenCalledWith("devbox");
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "ready",
    });
  });

  it("keeps the newest connection when two lifecycles complete out of order", async () => {
    const resolvers: Array<(value: RemoteBackendConnection) => void> = [];
    mocks.connectRemoteHost.mockImplementation(
      () =>
        new Promise<RemoteBackendConnection>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const older = useRemoteHostStore.getState().ensureHostConnected("devbox");
    const newer = useRemoteHostStore.getState().ensureHostConnected("devbox");
    const newestConnection = {
      ...connection,
      incarnation: "slot-new",
      generation: 4,
    };
    resolvers[1]?.(newestConnection);
    await expect(newer).resolves.toBe("connected");
    resolvers[0]?.({ ...connection, incarnation: "slot-old", generation: 9 });
    await expect(older).resolves.toBe("superseded");

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "ready",
      incarnation: newestConnection.incarnation,
      generation: newestConnection.generation,
    });
  });

  it("does not publish a connection that completes after Forget", async () => {
    const host = "forgotten.blox";
    let resolveConnect: (value: RemoteBackendConnection) => void = () => {};
    mocks.connectRemoteHost.mockImplementation(
      () =>
        new Promise<RemoteBackendConnection>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const pending = useRemoteHostStore.getState().ensureHostConnected(host);
    await useRemoteHostStore.getState().forgetHost(host);
    resolveConnect(connection);
    await pending;

    const state = useRemoteHostStore.getState();
    expect(state.statusByHost).not.toHaveProperty(host);
    expect(state.manualHosts).not.toContain(host);
    expect(state.forgottenHosts[host]).toBe(true);
  });

  it("marks the host failed with the typed error and rethrows", async () => {
    const error = { kind: "auth-failed", message: "permission denied" };
    mocks.connectRemoteHost.mockRejectedValue(error);

    await expect(
      useRemoteHostStore.getState().ensureHostConnected("devbox"),
    ).rejects.toBe(error);

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "failed",
      error,
    });
  });

  it("wraps non-typed connect errors as internal", async () => {
    mocks.connectRemoteHost.mockRejectedValue(new Error("boom"));

    await expect(
      useRemoteHostStore.getState().ensureHostConnected("devbox"),
    ).rejects.toThrow("boom");

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "failed",
      error: { kind: "internal", message: "boom" },
    });
  });
});

describe("disconnect and shutdownHost", () => {
  it("marks the host disconnected after disconnect", async () => {
    mocks.disconnectRemoteHost.mockResolvedValue(undefined);
    useRemoteHostStore
      .getState()
      .applyStatusEvent({ host: "devbox", ...backendIdentity, state: "ready" });

    await useRemoteHostStore.getState().disconnect("devbox");

    expect(mocks.disconnectRemoteHost).toHaveBeenCalledWith(
      "devbox",
      backendIdentity.generation,
    );
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "disconnected",
    });
  });

  it("marks the host disconnected after shutdown", async () => {
    mocks.shutdownRemoteHost.mockResolvedValue(undefined);
    useRemoteHostStore
      .getState()
      .applyStatusEvent({ host: "devbox", ...backendIdentity, state: "ready" });

    await useRemoteHostStore.getState().shutdownHost("devbox");

    expect(mocks.shutdownRemoteHost).toHaveBeenCalledWith(
      "devbox",
      undefined,
      backendIdentity.generation,
    );
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "disconnected",
    });
  });

  it("keeps an authoritative ready state when shutdown rejects before tunnel teardown", async () => {
    const daemonChanged = {
      kind: "daemon-changed",
      message: "remote daemon changed",
    };
    mocks.shutdownRemoteHost.mockRejectedValue(daemonChanged);
    useRemoteHostStore
      .getState()
      .applyStatusEvent({ host: "devbox", ...backendIdentity, state: "ready" });

    await expect(
      useRemoteHostStore.getState().shutdownHost("devbox"),
    ).rejects.toBe(daemonChanged);

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "ready",
    });
  });

  it("passes a conflict generation token to shutdown", async () => {
    mocks.shutdownRemoteHost.mockResolvedValue(undefined);

    await useRemoteHostStore
      .getState()
      .shutdownHost("devbox", "opaque-generation");

    expect(mocks.shutdownRemoteHost).toHaveBeenCalledWith(
      "devbox",
      "opaque-generation",
      undefined,
    );
  });

  it("does not publish a stale disconnect completion", async () => {
    let resolveDisconnect: () => void = () => {};
    mocks.disconnectRemoteHost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
    );
    useRemoteHostStore.setState({
      lifecycleByHost: { devbox: 1 },
      statusByHost: { devbox: { ...backendIdentity, state: "ready" } },
    });

    const pending = useRemoteHostStore.getState().disconnect("devbox");
    useRemoteHostStore.setState({
      lifecycleByHost: { devbox: 2 },
      statusByHost: {
        devbox: { incarnation: "slot-2", generation: 2, state: "ready" },
      },
    });
    resolveDisconnect();
    await pending;

    expect(mocks.disconnectRemoteHost).toHaveBeenCalledWith("devbox", 1);
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      incarnation: "slot-2",
      generation: 2,
      state: "ready",
    });
  });

  it("does not publish a stale shutdown completion", async () => {
    let resolveShutdown: () => void = () => {};
    mocks.shutdownRemoteHost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    useRemoteHostStore.setState({
      lifecycleByHost: { devbox: 1 },
      statusByHost: { devbox: { ...backendIdentity, state: "ready" } },
    });

    const pending = useRemoteHostStore.getState().shutdownHost("devbox");
    useRemoteHostStore.setState({
      lifecycleByHost: { devbox: 2 },
      statusByHost: {
        devbox: { incarnation: "slot-2", generation: 2, state: "ready" },
      },
    });
    resolveShutdown();
    await pending;

    expect(mocks.shutdownRemoteHost).toHaveBeenCalledWith(
      "devbox",
      undefined,
      1,
    );
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      incarnation: "slot-2",
      generation: 2,
      state: "ready",
    });
  });
});

describe("runDoctor", () => {
  const probes: RemoteToolProbe[] = [
    { binary: "goose", found: true, version: "1.2.3" },
    { binary: "claude-agent-acp", found: false },
  ];

  it("stores probe results and clears the pending flag", async () => {
    let resolveCheck: (value: RemoteToolProbe[]) => void = () => {};
    mocks.checkRemoteHost.mockImplementation(
      () =>
        new Promise<RemoteToolProbe[]>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const pending = useRemoteHostStore.getState().runDoctor("devbox");
    expect(useRemoteHostStore.getState().doctorPendingByHost.devbox).toBe(true);

    resolveCheck(probes);
    await pending;

    const state = useRemoteHostStore.getState();
    expect(state.doctorByHost.devbox).toEqual(probes);
    expect(state.doctorPendingByHost.devbox).toBe(false);
    expect(state.doctorErrorByHost.devbox).toBeUndefined();
  });

  it("captures the failure per host without throwing", async () => {
    mocks.checkRemoteHost.mockRejectedValue({
      kind: "ssh-not-found",
      message: "ssh missing",
    });

    await useRemoteHostStore.getState().runDoctor("devbox");

    const state = useRemoteHostStore.getState();
    expect(state.doctorByHost.devbox).toBeUndefined();
    expect(state.doctorPendingByHost.devbox).toBe(false);
    expect(state.doctorErrorByHost.devbox).toEqual({
      kind: "ssh-not-found",
      message: "ssh missing",
    });
  });
});

describe("recordRecentDir", () => {
  it("dedupes, keeps most-recent-first, caps at 8, and persists", () => {
    const store = useRemoteHostStore.getState();
    for (let i = 1; i <= 9; i++) {
      store.recordRecentDir("devbox", `~/repo-${i}`);
    }
    store.recordRecentDir("devbox", "~/repo-5");

    const dirs = useRemoteHostStore.getState().recentDirsByHost.devbox;
    expect(dirs).toHaveLength(8);
    expect(dirs[0]).toBe("~/repo-5");
    expect(dirs).not.toContain("~/repo-1");
    expect(new Set(dirs).size).toBe(dirs.length);

    const persisted = JSON.parse(
      window.localStorage.getItem(REMOTE_HOST_RECENT_DIRS_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.devbox).toEqual(dirs);
  });

  it("ignores empty hosts and dirs", () => {
    useRemoteHostStore.getState().recordRecentDir("devbox", "   ");
    useRemoteHostStore.getState().recordRecentDir("  ", "~/repo");

    expect(useRemoteHostStore.getState().recentDirsByHost).toEqual({});
  });

  it("rehydrates persisted recents and drops malformed entries", () => {
    window.localStorage.setItem(
      REMOTE_HOST_RECENT_DIRS_STORAGE_KEY,
      JSON.stringify({
        devbox: ["~/a", "~/b", 42, ""],
        broken: "not-an-array",
      }),
    );

    expect(loadPersistedRecentDirs()).toEqual({ devbox: ["~/a", "~/b"] });
  });

  it("returns no recents when storage holds invalid JSON", () => {
    window.localStorage.setItem(REMOTE_HOST_RECENT_DIRS_STORAGE_KEY, "{nope");

    expect(loadPersistedRecentDirs()).toEqual({});
  });
});

describe("goose binary override persistence", () => {
  it("saves, exposes, and persists a per-host path", () => {
    expect(
      useRemoteHostStore
        .getState()
        .setGoosePath("devbox", "  ~/src/goose/target/release/goose  "),
    ).toBe(true);

    expect(useRemoteHostStore.getState().goosePathByHost).toEqual({
      devbox: "~/src/goose/target/release/goose",
    });
    expect(loadPersistedGoosePaths()).toEqual({
      devbox: "~/src/goose/target/release/goose",
    });
    expect(getGoosePathForHost("devbox")).toBe(
      "~/src/goose/target/release/goose",
    );
    expect(getGoosePathForHost("other")).toBeUndefined();
  });

  it("clears an override and persists the removal", () => {
    const store = useRemoteHostStore.getState();
    store.setGoosePath("devbox", "/opt/goose/bin/goose");
    store.setGoosePath("gpu-1", "/opt/goose/bin/goose");

    expect(store.setGoosePath("devbox", null)).toBe(true);

    expect(useRemoteHostStore.getState().goosePathByHost).toEqual({
      "gpu-1": "/opt/goose/bin/goose",
    });
    expect(loadPersistedGoosePaths()).toEqual({
      "gpu-1": "/opt/goose/bin/goose",
    });
  });

  it("rejects paths the remote script could not resolve", () => {
    const store = useRemoteHostStore.getState();
    for (const candidate of [
      "",
      "   ",
      "goose",
      "./goose",
      "~goose",
      "/opt/goose/",
      "/opt/goose\ngoose",
    ]) {
      expect(store.setGoosePath("devbox", candidate)).toBe(false);
    }
    expect(store.setGoosePath("  ", "/opt/goose/bin/goose")).toBe(false);

    expect(useRemoteHostStore.getState().goosePathByHost).toEqual({});
    expect(
      window.localStorage.getItem(REMOTE_HOST_GOOSE_PATH_STORAGE_KEY),
    ).toBe(null);
  });

  it("tolerates corrupted storage and drops unusable entries", () => {
    window.localStorage.setItem(
      REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
      "not-json{",
    );
    expect(loadPersistedGoosePaths()).toEqual({});

    window.localStorage.setItem(
      REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
      JSON.stringify(["/opt/goose/bin/goose"]),
    );
    expect(loadPersistedGoosePaths()).toEqual({});

    window.localStorage.setItem(
      REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
      JSON.stringify({
        devbox: "/opt/goose/bin/goose",
        relative: "goose",
        numeric: 42,
        "": "/opt/goose/bin/goose",
      }),
    );
    expect(loadPersistedGoosePaths()).toEqual({
      devbox: "/opt/goose/bin/goose",
    });
  });
});

describe("initRemoteHostStore", () => {
  it("subscribes to status events, seeds state, and returns unsubscribe", async () => {
    const unlisten = vi.fn();
    let statusHandler:
      | ((payload: {
          host: string;
          incarnation: string;
          generation: number;
          state: string;
        }) => void)
      | undefined;
    mocks.listenRemoteBackendStatus.mockImplementation((handler) => {
      statusHandler = handler;
      return Promise.resolve(unlisten);
    });
    mocks.listRemoteBackends.mockResolvedValue([
      { host: "devbox", ...backendIdentity, state: "ready" },
    ]);
    mocks.listSshConfigHosts.mockResolvedValue(["devbox"]);

    const cleanup = await initRemoteHostStore();

    expect(useRemoteHostStore.getState().configHosts).toEqual(["devbox"]);
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      state: "ready",
    });

    statusHandler?.({
      host: "devbox",
      ...backendIdentity,
      generation: backendIdentity.generation + 1,
      state: "reconnecting",
    });
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      ...backendIdentity,
      generation: backendIdentity.generation + 1,
      state: "reconnecting",
    });

    expect(cleanup).toBe(unlisten);
  });
});

describe("manual host persistence", () => {
  it("remembers a connected host that is not in the ssh config", async () => {
    mocks.connectRemoteHost.mockResolvedValue(connection);
    useRemoteHostStore.setState({ configHosts: ["configured"] });

    await useRemoteHostStore.getState().ensureHostConnected("adhoc.blox");

    expect(useRemoteHostStore.getState().manualHosts).toEqual(["adhoc.blox"]);
    expect(loadPersistedManualHosts()).toEqual(["adhoc.blox"]);
  });

  it("retains concurrent already-ready manual hosts in state and storage", async () => {
    useRemoteHostStore.setState({
      statusByHost: {
        "alpha.blox": { ...backendIdentity, state: "ready" },
        "beta.blox": {
          incarnation: "slot-beta",
          generation: 2,
          state: "ready",
        },
      },
    });

    const accepted = await Promise.all([
      useRemoteHostStore.getState().ensureHostConnected("alpha.blox"),
      useRemoteHostStore.getState().ensureHostConnected("beta.blox"),
    ]);

    expect(accepted).toEqual(["connected", "connected"]);
    expect(useRemoteHostStore.getState().manualHosts).toEqual([
      "beta.blox",
      "alpha.blox",
    ]);
    expect(loadPersistedManualHosts()).toEqual(["beta.blox", "alpha.blox"]);
  });

  it("does not record ssh-config hosts as manual", async () => {
    mocks.connectRemoteHost.mockResolvedValue(connection);
    useRemoteHostStore.setState({ configHosts: ["configured"] });

    await useRemoteHostStore.getState().ensureHostConnected("configured");

    expect(useRemoteHostStore.getState().manualHosts).toEqual([]);
    expect(loadPersistedManualHosts()).toEqual([]);
  });

  it("does not remember hosts that failed to connect", async () => {
    mocks.connectRemoteHost.mockRejectedValue({
      kind: "host-unreachable",
      message: "no route",
    });

    await expect(
      useRemoteHostStore.getState().ensureHostConnected("nope.blox"),
    ).rejects.toBeTruthy();

    expect(useRemoteHostStore.getState().manualHosts).toEqual([]);
  });

  it("does not duplicate an already remembered host", async () => {
    mocks.connectRemoteHost.mockResolvedValue(connection);
    useRemoteHostStore.setState({ manualHosts: ["adhoc.blox"] });

    await useRemoteHostStore.getState().ensureHostConnected("adhoc.blox");

    expect(useRemoteHostStore.getState().manualHosts).toEqual(["adhoc.blox"]);
  });

  it("forgets a broken host while preserving reusable preferences", async () => {
    const host = "ssh broken.blox";
    useRemoteHostStore.setState({
      manualHosts: [host, "keep.blox"],
      statusByHost: {
        [host]: {
          state: "failed",
          error: { kind: "invalid-host", message: "invalid host" },
        },
      },
      doctorByHost: { [host]: [] },
      doctorPendingByHost: { [host]: false },
      doctorErrorByHost: {
        [host]: { kind: "invalid-host", message: "invalid host" },
      },
      recentDirsByHost: { [host]: ["~/src"] },
      goosePathByHost: { [host]: "~/bin/goose" },
    });
    window.localStorage.setItem(
      REMOTE_HOST_MANUAL_HOSTS_STORAGE_KEY,
      JSON.stringify([host, "keep.blox"]),
    );
    window.localStorage.setItem(
      REMOTE_HOST_RECENT_DIRS_STORAGE_KEY,
      JSON.stringify({ [host]: ["~/src"] }),
    );
    window.localStorage.setItem(
      REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
      JSON.stringify({ [host]: "~/bin/goose" }),
    );

    await useRemoteHostStore.getState().forgetHost(host);

    expect(mocks.forgetRemoteHost).toHaveBeenCalledWith(host);
    const state = useRemoteHostStore.getState();
    expect(state.manualHosts).toEqual(["keep.blox"]);
    expect(state.statusByHost).not.toHaveProperty(host);
    expect(state.doctorByHost).not.toHaveProperty(host);
    expect(state.doctorPendingByHost).not.toHaveProperty(host);
    expect(state.doctorErrorByHost).not.toHaveProperty(host);
    expect(state.recentDirsByHost[host]).toEqual(["~/src"]);
    expect(state.goosePathByHost[host]).toBe("~/bin/goose");
    expect(state.forgottenHosts[host]).toBe(true);
    expect(loadPersistedManualHosts()).toEqual(["keep.blox"]);
    expect(loadPersistedRecentDirs()).toEqual({ [host]: ["~/src"] });
    expect(loadPersistedGoosePaths()).toEqual({ [host]: "~/bin/goose" });
  });

  it("does not let a late Forget completion erase a newer connection", async () => {
    const host = "adhoc.blox";
    let resolveForget: () => void = () => {};
    mocks.forgetRemoteHost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveForget = resolve;
        }),
    );
    useRemoteHostStore.setState({
      lifecycleByHost: { [host]: 1 },
      manualHosts: [host],
      statusByHost: { [host]: { ...backendIdentity, state: "disconnected" } },
    });

    const forgetting = useRemoteHostStore.getState().forgetHost(host);
    const replacement = {
      ...connection,
      incarnation: "slot-replacement",
      generation: 7,
    };
    mocks.connectRemoteHost.mockResolvedValue(replacement);
    await useRemoteHostStore.getState().ensureHostConnected(host);
    resolveForget();
    await forgetting;

    const state = useRemoteHostStore.getState();
    expect(state.statusByHost[host]).toEqual({
      state: "ready",
      incarnation: replacement.incarnation,
      generation: replacement.generation,
    });
    expect(state.manualHosts).toContain(host);
    expect(state.forgottenHosts[host]).toBeUndefined();
    expect(state.forgetPendingByHost[host]).toBeUndefined();
  });

  it("keeps local state when the backend refuses to forget an active host", async () => {
    mocks.forgetRemoteHost.mockRejectedValueOnce(new Error("active"));
    useRemoteHostStore.setState({
      manualHosts: ["adhoc.blox"],
      statusByHost: { "adhoc.blox": { state: "ready" } },
    });

    await expect(
      useRemoteHostStore.getState().forgetHost("adhoc.blox"),
    ).rejects.toThrow("active");

    expect(useRemoteHostStore.getState().manualHosts).toEqual(["adhoc.blox"]);
    expect(useRemoteHostStore.getState().statusByHost).toHaveProperty(
      "adhoc.blox",
    );
    expect(
      useRemoteHostStore.getState().forgetPendingByHost["adhoc.blox"],
    ).toBe(false);
    expect(
      useRemoteHostStore.getState().forgetErrorByHost["adhoc.blox"],
    ).toEqual({ kind: "internal", message: "active" });
  });

  it("ignores late status events until an intentional reconnect", async () => {
    const host = "broken.blox";
    useRemoteHostStore.setState({
      statusByHost: { [host]: { ...backendIdentity, state: "failed" } },
    });

    await useRemoteHostStore.getState().forgetHost(host);
    useRemoteHostStore.getState().applyStatusEvent({
      host,
      ...backendIdentity,
      state: "disconnected",
    });
    expect(useRemoteHostStore.getState().statusByHost).not.toHaveProperty(host);

    const replacementConnection = {
      ...connection,
      incarnation: "slot-2",
    };
    mocks.connectRemoteHost.mockResolvedValue(replacementConnection);
    await useRemoteHostStore.getState().ensureHostConnected(host);
    useRemoteHostStore.getState().applyStatusEvent({
      host,
      incarnation: "slot-2",
      generation: 2,
      state: "reconnecting",
      attempt: 1,
    });
    expect(useRemoteHostStore.getState().statusByHost[host]).toEqual({
      incarnation: "slot-2",
      generation: 2,
      state: "reconnecting",
      attempt: 1,
    });
  });

  it("ignores a retired incarnation after a replacement reconnects", async () => {
    const host = "broken.blox";
    useRemoteHostStore.setState({
      statusByHost: { [host]: { ...backendIdentity, state: "failed" } },
    });
    await useRemoteHostStore.getState().forgetHost(host);
    mocks.connectRemoteHost.mockResolvedValue({
      ...connection,
      incarnation: "slot-2",
    });
    await useRemoteHostStore.getState().ensureHostConnected(host);

    useRemoteHostStore.getState().applyStatusEvent({
      host,
      incarnation: connection.incarnation,
      generation: 99,
      state: "disconnected",
    });

    expect(useRemoteHostStore.getState().statusByHost[host]).toEqual({
      state: "ready",
      incarnation: "slot-2",
      generation: connection.generation,
    });
  });

  it("exposes forget pending and failure state and deduplicates submissions", async () => {
    const host = "broken.blox";
    let rejectForget: (error: unknown) => void = () => {};
    mocks.forgetRemoteHost.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectForget = reject;
        }),
    );
    useRemoteHostStore.setState({
      statusByHost: { [host]: { state: "failed" } },
    });

    const first = useRemoteHostStore.getState().forgetHost(host);
    const firstResult = expect(first).rejects.toEqual({
      kind: "internal",
      message: "still connecting",
    });
    expect(useRemoteHostStore.getState().forgetPendingByHost[host]).toBe(true);
    const duplicate = useRemoteHostStore.getState().forgetHost(host);
    expect(mocks.forgetRemoteHost).toHaveBeenCalledTimes(1);

    rejectForget({ kind: "internal", message: "still connecting" });
    await firstResult;
    await duplicate;
    expect(useRemoteHostStore.getState().forgetPendingByHost[host]).toBe(false);
    expect(useRemoteHostStore.getState().forgetErrorByHost[host]).toEqual({
      kind: "internal",
      message: "still connecting",
    });
  });

  it("tolerates corrupted storage when loading manual hosts", () => {
    window.localStorage.setItem(
      REMOTE_HOST_MANUAL_HOSTS_STORAGE_KEY,
      "not-json{",
    );
    expect(loadPersistedManualHosts()).toEqual([]);

    window.localStorage.setItem(
      REMOTE_HOST_MANUAL_HOSTS_STORAGE_KEY,
      JSON.stringify([42, "", "real.host"]),
    );
    expect(loadPersistedManualHosts()).toEqual(["real.host"]);
  });
});
