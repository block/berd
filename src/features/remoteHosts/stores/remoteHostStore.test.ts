import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteBackendConnection,
  RemoteToolProbe,
} from "@/shared/api/remoteHosts";

const mocks = vi.hoisted(() => ({
  listSshConfigHosts: vi.fn(),
  connectRemoteHost: vi.fn(),
  disconnectRemoteHost: vi.fn(),
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
  initRemoteHostStore,
  loadPersistedRecentDirs,
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
};

function resetStore(): void {
  useRemoteHostStore.setState({
    configHosts: [],
    statusByHost: {},
    doctorByHost: {},
    doctorPendingByHost: {},
    doctorErrorByHost: {},
    recentDirsByHost: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetStore();
});

describe("applyStatusEvent", () => {
  it("updates statusByHost from status events", () => {
    useRemoteHostStore.getState().applyStatusEvent({
      host: "devbox",
      state: "reconnecting",
      attempt: 2,
    });

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "reconnecting",
      attempt: 2,
    });
  });

  it("clears a previous error when a ready event arrives", () => {
    useRemoteHostStore.getState().applyStatusEvent({
      host: "devbox",
      state: "failed",
      error: { kind: "host-unreachable", message: "no route" },
    });
    expect(
      useRemoteHostStore.getState().statusByHost.devbox.error,
    ).toBeDefined();

    useRemoteHostStore.getState().applyStatusEvent({
      host: "devbox",
      state: "ready",
      wsUrl: connection.wsUrl,
      localPort: connection.localPort,
    });

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "ready",
    });
  });
});

describe("syncBackendSnapshot", () => {
  it("copies snapshot entries into statusByHost", async () => {
    mocks.listRemoteBackends.mockResolvedValue([
      { host: "devbox", state: "ready" },
      {
        host: "broken",
        state: "failed",
        error: { kind: "auth-failed", message: "denied" },
      },
    ]);

    await useRemoteHostStore.getState().syncBackendSnapshot();

    const { statusByHost } = useRemoteHostStore.getState();
    expect(statusByHost.devbox).toEqual({ state: "ready" });
    expect(statusByHost.broken).toEqual({
      state: "failed",
      error: { kind: "auth-failed", message: "denied" },
    });
  });

  it("keeps the previous statuses when the snapshot fails", async () => {
    useRemoteHostStore
      .getState()
      .applyStatusEvent({ host: "devbox", state: "ready" });
    mocks.listRemoteBackends.mockRejectedValue(new Error("ipc down"));

    await useRemoteHostStore.getState().syncBackendSnapshot();

    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "ready",
    });
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
      .applyStatusEvent({ host: "devbox", state: "ready" });

    await useRemoteHostStore.getState().ensureHostConnected("devbox");

    expect(mocks.connectRemoteHost).not.toHaveBeenCalled();
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
      state: "ready",
    });
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
      .applyStatusEvent({ host: "devbox", state: "ready" });

    await useRemoteHostStore.getState().disconnect("devbox");

    expect(mocks.disconnectRemoteHost).toHaveBeenCalledWith("devbox");
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "disconnected",
    });
  });

  it("marks the host disconnected after shutdown", async () => {
    mocks.shutdownRemoteHost.mockResolvedValue(undefined);
    useRemoteHostStore
      .getState()
      .applyStatusEvent({ host: "devbox", state: "ready" });

    await useRemoteHostStore.getState().shutdownHost("devbox");

    expect(mocks.shutdownRemoteHost).toHaveBeenCalledWith("devbox");
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "disconnected",
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

describe("initRemoteHostStore", () => {
  it("subscribes to status events, seeds state, and returns unsubscribe", async () => {
    const unlisten = vi.fn();
    let statusHandler:
      | ((payload: { host: string; state: string }) => void)
      | undefined;
    mocks.listenRemoteBackendStatus.mockImplementation((handler) => {
      statusHandler = handler;
      return Promise.resolve(unlisten);
    });
    mocks.listRemoteBackends.mockResolvedValue([
      { host: "devbox", state: "ready" },
    ]);
    mocks.listSshConfigHosts.mockResolvedValue(["devbox"]);

    const cleanup = await initRemoteHostStore();

    expect(useRemoteHostStore.getState().configHosts).toEqual(["devbox"]);
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "ready",
    });

    statusHandler?.({ host: "devbox", state: "reconnecting" });
    expect(useRemoteHostStore.getState().statusByHost.devbox).toEqual({
      state: "reconnecting",
    });

    expect(cleanup).toBe(unlisten);
  });
});
