import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import {
  LOCAL_BACKEND_ID,
  backendIdForSession,
  compositeSessionId,
  isCompositeSessionId,
  remoteHostFromBackendId,
  splitCompositeSessionId,
  sshBackendId,
} from "../acpBackendId";

interface FakeClient {
  initialize: ReturnType<typeof vi.fn>;
  closed: Promise<void>;
  resolveClosed: () => void;
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  connectRemoteHost: vi.fn(),
  disconnectRemoteHost: vi.fn(),
  createWebSocketStream: vi.fn(),
  initialize: vi.fn(),
  sessionInfo: vi.fn(),
  loadSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
  updateWorkingDir: vi.fn(),
  clientCallbackFactories: [] as Array<() => Client>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("../createWebSocketStream", () => ({
  createWebSocketStream: (...args: unknown[]) =>
    mocks.createWebSocketStream(...args),
}));

vi.mock("../remoteHosts", () => ({
  connectRemoteHost: (...args: unknown[]) => mocks.connectRemoteHost(...args),
  disconnectRemoteHost: (...args: unknown[]) =>
    mocks.disconnectRemoteHost(...args),
}));

vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: 1,
}));

vi.mock("@aaif/goose-sdk", () => ({
  DEFAULT_GOOSE_MCP_HOST_CAPABILITIES: {},
  GooseClient: class {
    initialize = vi.fn((...args: unknown[]) => mocks.initialize(...args));
    goose = {
      GooseUnstableSessionInfo: mocks.sessionInfo,
      GooseUnstableSessionWorkingDirUpdate: mocks.updateWorkingDir,
    };
    loadSession = mocks.loadSession;
    setSessionConfigOption = mocks.setSessionConfigOption;
    closed: Promise<void>;
    resolveClosed!: () => void;
    constructor(callbacks: () => Client, _stream: unknown) {
      mocks.clientCallbackFactories.push(callbacks);
      this.closed = new Promise<void>((resolve) => {
        this.resolveClosed = resolve;
      });
    }
  },
}));

async function importConnection() {
  return import("../acpConnection");
}

async function importSessionBackends() {
  return import("../acpSessionBackends");
}

/** Lets the closed-monitor promise chain run before asserting. */
function flushClosedMonitor() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  window.localStorage.setItem(
    "goose:experimental-features",
    JSON.stringify({
      version: 2,
      experiments: { "remote-ssh-sessions": { enabled: true } },
    }),
  );
  mocks.clientCallbackFactories.length = 0;
  mocks.initialize.mockReset().mockResolvedValue(undefined);
  mocks.sessionInfo.mockReset();
  mocks.loadSession.mockReset().mockResolvedValue({ configOptions: [] });
  mocks.setSessionConfigOption
    .mockReset()
    .mockResolvedValue({ configOptions: [] });
  mocks.updateWorkingDir.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue("ws://local");
  mocks.connectRemoteHost.mockResolvedValue({
    wsUrl: "ws://remote",
    httpBaseUrl: "http://remote",
    secretKey: "secret",
    localPort: 4242,
    generation: 1,
  });
  mocks.disconnectRemoteHost.mockResolvedValue(undefined);
  mocks.createWebSocketStream.mockImplementation(() => ({
    writable: { abort: vi.fn().mockResolvedValue(undefined) },
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("acpBackendId", () => {
  it("builds ssh backend ids from trimmed hosts", () => {
    expect(sshBackendId(" dev-box ")).toBe("ssh:dev-box");
  });

  it("extracts the remote host, or null for local", () => {
    expect(remoteHostFromBackendId(LOCAL_BACKEND_ID)).toBeNull();
    expect(remoteHostFromBackendId("ssh:dev-box")).toBe("dev-box");
  });

  it("derives a session's backend id from its remote host", () => {
    expect(backendIdForSession(null)).toBe("local");
    expect(backendIdForSession(undefined)).toBe("local");
    expect(backendIdForSession({})).toBe("local");
    expect(backendIdForSession({ remoteHost: null })).toBe("local");
    expect(backendIdForSession({ remoteHost: "  " })).toBe("local");
    expect(backendIdForSession({ remoteHost: " dev-box " })).toBe(
      "ssh:dev-box",
    );
  });

  it("keeps local wire ids unchanged and composes remote ones", () => {
    expect(compositeSessionId("local", "20260828_2")).toBe("20260828_2");
    expect(compositeSessionId("ssh:workstation.blox", "20260828_2")).toBe(
      "ssh:workstation.blox#20260828_2",
    );
  });

  it("detects composite ids without false positives", () => {
    expect(isCompositeSessionId("ssh:workstation.blox#20260828_2")).toBe(true);
    expect(isCompositeSessionId("20260828_2")).toBe(false);
    // A bare backend id is not a session id.
    expect(isCompositeSessionId("ssh:workstation.blox")).toBe(false);
    // A local id containing '#' is not composite either.
    expect(isCompositeSessionId("weird#local")).toBe(false);
  });

  it("splits composite ids, including hosts containing ':'", () => {
    expect(splitCompositeSessionId("ssh:dev-box#20260828_2")).toEqual({
      backendId: "ssh:dev-box",
      wireSessionId: "20260828_2",
    });
    expect(splitCompositeSessionId("ssh:user@host:2222#20260828_1")).toEqual({
      backendId: "ssh:user@host:2222",
      wireSessionId: "20260828_1",
    });
    expect(splitCompositeSessionId("20260828_2")).toBeNull();
    expect(splitCompositeSessionId("ssh:no-separator")).toBeNull();
  });

  it("roundtrips composite ids through split", () => {
    const id = compositeSessionId("ssh:user@host:2222", "20260828_1");
    expect(id).toBe("ssh:user@host:2222#20260828_1");
    expect(splitCompositeSessionId(id)).toEqual({
      backendId: "ssh:user@host:2222",
      wireSessionId: "20260828_1",
    });
  });
});

describe("backend connection registry", () => {
  it("memoizes one connection per backend id", async () => {
    const conn = await importConnection();

    expect(conn.getBackendConnection("local")).toBe(
      conn.getBackendConnection("local"),
    );
    expect(conn.getBackendConnection("ssh:host-a")).toBe(
      conn.getBackendConnection("ssh:host-a"),
    );
    expect(conn.getBackendConnection("ssh:host-a")).not.toBe(
      conn.getBackendConnection("local"),
    );
    expect(conn.getBackendConnection("ssh:host-a")).not.toBe(
      conn.getBackendConnection("ssh:host-b"),
    );
  });

  it("serves getClient() from the local backend connection", async () => {
    const conn = await importConnection();

    const legacyClient = await conn.getClient();
    const backendClient = await conn.getBackendClient("local");

    expect(backendClient).toBe(legacyClient);
    expect(conn.getClientSync()).toBe(legacyClient);
    expect(conn.isClientReady()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_goose_serve_url");
    expect(mocks.connectRemoteHost).not.toHaveBeenCalled();
  });

  it("dials ssh backends through connectRemoteHost", async () => {
    const conn = await importConnection();

    await conn.getBackendClient("ssh:dev-box");

    expect(mocks.connectRemoteHost).toHaveBeenCalledWith("dev-box");
    expect(mocks.createWebSocketStream).toHaveBeenCalledWith("ws://remote");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("blocks and invalidates ssh transports when the experiment is disabled", async () => {
    const conn = await importConnection();
    const remoteConnection = conn.getBackendConnection("ssh:dev-box");
    await remoteConnection.getClient();
    const remoteStream = mocks.createWebSocketStream.mock.results.at(-1)
      ?.value as { writable: { abort: ReturnType<typeof vi.fn> } };

    window.localStorage.setItem(
      "goose:experimental-features",
      JSON.stringify({
        version: 2,
        experiments: { "remote-ssh-sessions": { enabled: false } },
      }),
    );
    window.dispatchEvent(new Event("goose:experimental-features-change"));
    await Promise.resolve();

    expect(remoteStream.writable.abort).toHaveBeenCalledOnce();
    expect(() => conn.getBackendConnection("ssh:dev-box")).toThrow(
      "Remote SSH sessions are disabled",
    );
    await expect(remoteConnection.getClient()).rejects.toThrow(
      "Remote SSH sessions are disabled",
    );
    expect(mocks.connectRemoteHost).toHaveBeenCalledTimes(1);
  });

  it("disposes a remote setup that resolves after experiment invalidation", async () => {
    let resolveRemote!: (value: {
      wsUrl: string;
      httpBaseUrl: string;
      secretKey: string;
      localPort: number;
      generation: number;
    }) => void;
    mocks.connectRemoteHost.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRemote = resolve;
      }),
    );
    const conn = await importConnection();
    const remoteConnection = conn.getBackendConnection("ssh:dev-box");
    const pendingClient = remoteConnection.getClient();

    window.localStorage.setItem(
      "goose:experimental-features",
      JSON.stringify({
        version: 2,
        experiments: { "remote-ssh-sessions": { enabled: false } },
      }),
    );
    window.dispatchEvent(new Event("goose:experimental-features-change"));
    resolveRemote({
      wsUrl: "ws://stale-remote",
      httpBaseUrl: "http://stale-remote",
      secretKey: "stale",
      localPort: 4343,
      generation: 7,
    });

    await expect(pendingClient).rejects.toThrow(
      "Remote SSH sessions are disabled",
    );
    expect(mocks.createWebSocketStream).not.toHaveBeenCalled();
    expect(mocks.disconnectRemoteHost).toHaveBeenCalledWith("dev-box", 7);
    expect(remoteConnection.getClientSync()).toBeNull();

    window.localStorage.setItem(
      "goose:experimental-features",
      JSON.stringify({
        version: 2,
        experiments: { "remote-ssh-sessions": { enabled: true } },
      }),
    );
    window.dispatchEvent(new Event("goose:experimental-features-change"));
    mocks.connectRemoteHost.mockResolvedValueOnce({
      wsUrl: "ws://fresh-remote",
      httpBaseUrl: "http://fresh-remote",
      secretKey: "fresh",
      localPort: 4444,
      generation: 8,
    });

    await expect(remoteConnection.getClient()).resolves.toBeDefined();
    expect(mocks.createWebSocketStream).toHaveBeenCalledWith(
      "ws://fresh-remote",
    );
  });

  it("re-runs the ws-url resolver after the connection closes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const conn = await importConnection();
    const first = (await conn.getClient()) as unknown as FakeClient;
    const onClosed = vi.fn();
    conn.getBackendConnection("local").onClosed(onClosed);

    first.resolveClosed();
    await flushClosedMonitor();

    expect(onClosed).toHaveBeenCalledOnce();
    expect(conn.isClientReady()).toBe(false);
    expect(conn.getClientSync()).toBeNull();

    const second = await conn.getClient();
    expect(second).not.toBe(first);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("invalidates one backend without clearing the others", async () => {
    const conn = await importConnection();
    const localClient = await conn.getClient();
    const remoteClient = await conn.getBackendClient("ssh:dev-box");
    const remoteStream = mocks.createWebSocketStream.mock.results.at(-1)
      ?.value as { writable: { abort: ReturnType<typeof vi.fn> } };

    await conn.invalidateBackendConnection("ssh:dev-box");

    expect(remoteStream.writable.abort).toHaveBeenCalledOnce();
    expect(await conn.getClient()).toBe(localClient);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    const remoteAgain = await conn.getBackendClient("ssh:dev-box");
    expect(remoteAgain).not.toBe(remoteClient);
    expect(mocks.connectRemoteHost).toHaveBeenCalledTimes(2);
  });

  it.each([
    "local",
    "ssh:dev-box",
  ] as const)("detaches %s synchronously and preserves its replacement during late cleanup", async (backendId) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const conn = await importConnection();
    const connection = conn.getBackendConnection(backendId);
    let resolveAbort!: () => void;
    let resolveDisconnect!: () => void;
    const oldStream = {
      writable: {
        abort: vi.fn().mockReturnValue(
          new Promise<void>((resolve) => {
            resolveAbort = resolve;
          }),
        ),
      },
    };
    mocks.createWebSocketStream.mockReturnValueOnce(oldStream);
    const first = (await connection.getClient()) as unknown as FakeClient;
    const onClosed = vi.fn();
    connection.onClosed(onClosed);
    if (backendId !== "local") {
      mocks.disconnectRemoteHost.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
      );
      mocks.connectRemoteHost.mockResolvedValueOnce({
        wsUrl: "ws://replacement",
        generation: 2,
      });
    }

    let cleanupSettled = false;
    const cleanup = conn.invalidateBackendConnection(backendId).then(() => {
      cleanupSettled = true;
    });
    // These assertions deliberately precede any await: timeout callers
    // depend on detachment happening before invalidation returns.
    expect(connection.getClientSync()).toBeNull();
    expect(connection.isReady()).toBe(false);
    expect(oldStream.writable.abort).toHaveBeenCalledOnce();
    if (backendId !== "local") {
      expect(mocks.disconnectRemoteHost).toHaveBeenCalledExactlyOnceWith(
        "dev-box",
        1,
      );
    }

    const second = await conn.getBackendClient(backendId);
    const newStream = mocks.createWebSocketStream.mock.results.at(-1)
      ?.value as { writable: { abort: ReturnType<typeof vi.fn> } };
    expect(second).not.toBe(first);
    expect(cleanupSettled).toBe(false);
    expect(connection.getClientSync()).toBe(second);

    first.resolveClosed();
    await flushClosedMonitor();
    expect(onClosed).not.toHaveBeenCalled();
    expect(connection.getClientSync()).toBe(second);

    resolveAbort();
    resolveDisconnect?.();
    await cleanup;
    expect(await connection.getClient()).toBe(second);
    expect(connection.isReady()).toBe(true);
    expect(newStream.writable.abort).not.toHaveBeenCalled();
    expect(oldStream.writable.abort).toHaveBeenCalledOnce();
    if (backendId !== "local") {
      expect(mocks.connectRemoteHost).toHaveBeenCalledTimes(2);
      expect(mocks.createWebSocketStream).toHaveBeenLastCalledWith(
        "ws://replacement",
      );
      expect(mocks.disconnectRemoteHost).toHaveBeenCalledExactlyOnceWith(
        "dev-box",
        1,
      );
    } else {
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
      expect(mocks.disconnectRemoteHost).not.toHaveBeenCalled();
    }
  });

  it.each([
    "local",
    "ssh:dev-box",
  ] as const)("does not let a second old-session timeout invalidate the %s replacement", async (backendId) => {
    vi.useFakeTimers();
    const conn = await importConnection();
    const { loadSession } = await import("../acpSessionRegistry");
    const firstId = compositeSessionId(backendId, "session-1");
    const secondId = compositeSessionId(backendId, "session-2");
    mocks.sessionInfo.mockReturnValue(new Promise(() => {}));

    const first = loadSession(firstId);
    const firstRejection = expect(first).rejects.toThrow(
      "ACP operation timed out",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const second = loadSession(secondId);
    const secondRejection = expect(second).rejects.toThrow(
      "ACP operation timed out",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sessionInfo).toHaveBeenCalledTimes(2);
    expect(mocks.createWebSocketStream).toHaveBeenCalledOnce();
    const oldStream = mocks.createWebSocketStream.mock.results[0].value;

    await vi.advanceTimersByTimeAsync(50_000);
    await firstRejection;
    expect(oldStream.writable.abort).toHaveBeenCalledOnce();
    await loadSession(firstId, "/new/project");
    const connection = conn.getBackendConnection(backendId);
    const replacement = connection.getClientSync();
    const newStream = mocks.createWebSocketStream.mock.results[1].value;
    expect(replacement).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    await secondRejection;
    expect(newStream.writable.abort).not.toHaveBeenCalled();
    expect(connection.getClientSync()).toBe(replacement);
    expect(await connection.getClient()).toBe(replacement);
    expect(mocks.createWebSocketStream).toHaveBeenCalledTimes(2);
  });

  it.each([
    "close",
    "initialize failure",
  ])("retires the captured generation after %s without invalidating its replacement", async (failure) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const conn = await importConnection();
    const connection = conn.getBackendConnection("local");
    const generation = connection.captureGeneration();
    if (failure === "close") {
      const first = (await connection.getClient()) as unknown as FakeClient;
      first.resolveClosed();
      await flushClosedMonitor();
    } else {
      mocks.initialize.mockRejectedValueOnce(new Error("failed initialize"));
      await expect(connection.getClient()).rejects.toThrow("failed initialize");
    }
    expect(generation.isCurrent()).toBe(false);
    const replacement = await connection.getClient();
    const stream = mocks.createWebSocketStream.mock.results.at(-1)?.value;

    await generation.invalidate();

    expect(connection.getClientSync()).toBe(replacement);
    expect(stream.writable.abort).not.toHaveBeenCalled();
  });

  it.each([
    "cold provider",
    "cold load",
    "model",
    "configuration",
    "working directory",
  ])("does not let a late %s mutation overwrite or publish newer session state", async (operation) => {
    vi.useFakeTimers();
    const registry = await import("../acpSessionRegistry");
    const { setSessionConfigSnapshotHandlers } = await import(
      "../acpSessionConfigSnapshots"
    );
    const configResponse = (
      providerId: string,
      modelId: string,
      effort: string,
    ) => ({
      configOptions: [
        {
          id: "provider",
          kind: { type: "select", currentValue: providerId, options: [] },
        },
        {
          id: "model",
          category: "model",
          kind: { type: "select", currentValue: modelId, options: [] },
        },
        {
          id: "thinking_effort",
          category: "thought_level",
          kind: { type: "select", currentValue: effort, options: [] },
        },
      ],
    });
    const published = vi.fn();
    setSessionConfigSnapshotHandlers({ applyConfigSnapshots: published });
    mocks.setSessionConfigOption.mockResolvedValue(
      configResponse("openai", "new-model", "high"),
    );
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise((resolve) => {
      resolveOld = resolve;
    });
    let old: Promise<unknown>;
    if (operation.startsWith("cold")) {
      if (operation === "cold load") {
        mocks.loadSession.mockReturnValueOnce(oldResponse);
      } else {
        mocks.setSessionConfigOption.mockReturnValueOnce(oldResponse);
      }
      old = registry.configureSession(
        "session-1",
        "anthropic",
        "/stale/project",
        "stale-model",
      );
    } else {
      registry.registerPreparedSession(
        "session-1",
        "openai",
        "/initial/project",
        "initial-model",
      );
      if (operation === "working directory") {
        mocks.updateWorkingDir.mockReturnValueOnce(oldResponse);
        old = registry.prepareSession(
          "session-1",
          "anthropic",
          "/stale/project",
        );
      } else {
        mocks.setSessionConfigOption.mockReturnValueOnce(oldResponse);
        old =
          operation === "model"
            ? registry.applySessionModel("session-1", "stale-model")
            : registry.applySessionConfigOption(
                "session-1",
                "thinking_effort",
                "low",
              );
      }
    }
    const rejection = expect(old).rejects.toThrow("ACP operation timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    await registry.configureSession(
      "session-1",
      "openai",
      "/new/project",
      "new-model",
    );
    const newPublications = [...published.mock.calls];
    const newRequests = [...mocks.setSessionConfigOption.mock.calls];
    expect(newPublications.length).toBeGreaterThan(0);
    expect(registry.requireSessionInvocationSelection("session-1")).toEqual({
      providerId: "openai",
      modelId: "new-model",
    });

    resolveOld(configResponse("anthropic", "stale-model", "low"));
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.requireSessionInvocationSelection("session-1")).toEqual({
      providerId: "openai",
      modelId: "new-model",
    });
    expect(published.mock.calls).toEqual(newPublications);
    expect(mocks.setSessionConfigOption.mock.calls).toEqual(newRequests);
    await registry.loadSession("session-1");
    expect(mocks.loadSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      cwd: "/new/project",
      mcpServers: [],
    });
  });

  it("delegates invalidateClientConnection to the local backend only", async () => {
    const conn = await importConnection();
    const localClient = await conn.getClient();
    const remoteClient = await conn.getBackendClient("ssh:dev-box");

    await conn.invalidateClientConnection();

    expect(await conn.getBackendClient("ssh:dev-box")).toBe(remoteClient);
    const localAgain = await conn.getClient();
    expect(localAgain).not.toBe(localClient);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("session backend routing", () => {
  it("defaults unregistered sessions to the local backend", async () => {
    const conn = await importConnection();
    const sessions = await importSessionBackends();

    expect(sessions.getSessionBackend("unknown-session")).toBe("local");
    const client = await sessions.getClientForSession("unknown-session");
    expect(client).toBe(await conn.getClient());
    expect(mocks.connectRemoteHost).not.toHaveBeenCalled();
  });

  it("registers, transfers, and unregisters session backends", async () => {
    const sessions = await importSessionBackends();

    sessions.registerSessionBackend("session-1", "ssh:dev-box");
    expect(sessions.getSessionBackend("session-1")).toBe("ssh:dev-box");

    sessions.transferSessionBackend("session-1", "session-2");
    expect(sessions.getSessionBackend("session-2")).toBe("ssh:dev-box");

    // Transferring from an unregistered session is a no-op.
    sessions.transferSessionBackend("never-registered", "session-3");
    expect(sessions.getSessionBackend("session-3")).toBe("local");

    sessions.unregisterSessionBackend("session-1");
    expect(sessions.getSessionBackend("session-1")).toBe("local");
    expect(sessions.getSessionBackend("session-2")).toBe("ssh:dev-box");
  });

  it("routes getClientForSession through the registered backend", async () => {
    const conn = await importConnection();
    const sessions = await importSessionBackends();
    sessions.registerSessionBackend("session-1", "ssh:dev-box");

    const remoteClient = await sessions.getClientForSession("session-1");

    expect(mocks.connectRemoteHost).toHaveBeenCalledWith("dev-box");
    expect(remoteClient).toBe(await conn.getBackendClient("ssh:dev-box"));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("returns the registered wire id, defaulting to the session id", async () => {
    const sessions = await importSessionBackends();

    sessions.registerSessionBackend(
      "ssh:dev-box#20260828_2",
      "ssh:dev-box",
      "20260828_2",
    );
    expect(sessions.getWireSessionId("ssh:dev-box#20260828_2")).toBe(
      "20260828_2",
    );

    sessions.registerSessionBackend("local-session", "local");
    expect(sessions.getWireSessionId("local-session")).toBe("local-session");
    expect(sessions.getWireSessionId("never-registered")).toBe(
      "never-registered",
    );

    // Registering a composite id without an explicit wire id derives it from
    // the id's shape instead of storing the composite as the wire id.
    sessions.registerSessionBackend("ssh:dev-box#20260828_9", "ssh:dev-box");
    expect(sessions.getWireSessionId("ssh:dev-box#20260828_9")).toBe(
      "20260828_9",
    );
  });

  it("derives backend and wire id from an unregistered composite id", async () => {
    const conn = await importConnection();
    const sessions = await importSessionBackends();

    // Restart safety: a composite id can be consulted before rehydration
    // re-registers it.
    expect(sessions.getSessionBackend("ssh:user@host:2222#20260828_1")).toBe(
      "ssh:user@host:2222",
    );
    expect(sessions.getWireSessionId("ssh:user@host:2222#20260828_1")).toBe(
      "20260828_1",
    );

    const client = await sessions.getClientForSession(
      "ssh:user@host:2222#20260828_1",
    );
    expect(mocks.connectRemoteHost).toHaveBeenCalledWith("user@host:2222");
    expect(client).toBe(await conn.getBackendClient("ssh:user@host:2222"));
  });

  it("transfer keeps the destination's own wire id", async () => {
    const sessions = await importSessionBackends();

    // Draft flow: the draft's uuid is registered on the remote backend, then
    // the created composite id (already registered with its wire id) takes
    // over. The transfer must not clobber the destination's wire id with the
    // draft uuid.
    sessions.registerSessionBackend(
      "ssh:dev-box#20260828_2",
      "ssh:dev-box",
      "20260828_2",
    );
    sessions.registerSessionBackend("draft-uuid", "ssh:dev-box");
    sessions.transferSessionBackend("draft-uuid", "ssh:dev-box#20260828_2");

    expect(sessions.getSessionBackend("ssh:dev-box#20260828_2")).toBe(
      "ssh:dev-box",
    );
    expect(sessions.getWireSessionId("ssh:dev-box#20260828_2")).toBe(
      "20260828_2",
    );

    // Unregistered composite destination derives its wire id from its shape.
    sessions.transferSessionBackend("draft-uuid", "ssh:dev-box#20260828_3");
    expect(sessions.getWireSessionId("ssh:dev-box#20260828_3")).toBe(
      "20260828_3",
    );
  });
});

describe("inbound session id translation", () => {
  function sessionUpdatePayload(sessionId: string): SessionNotification {
    return {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    } as SessionNotification;
  }

  async function latestCallbacks(): Promise<Client> {
    const factory = mocks.clientCallbackFactories.at(-1);
    if (!factory) {
      throw new Error("no GooseClient constructed");
    }
    return factory();
  }

  it.each([
    LOCAL_BACKEND_ID,
    sshBackendId("dev-box"),
  ])("ignores notifications from a detached %s generation even while cleanup hangs", async (backendId) => {
    const conn = await importConnection();
    const received = vi.fn();
    const intercepted = vi.fn(() => false);
    conn.setNotificationHandler({ handleSessionNotification: received });
    const stop = conn.interceptSessionNotifications(intercepted);
    const connection = conn.getBackendConnection(backendId);
    await connection.getClient();
    const oldCallbacks = await latestCallbacks();
    const oldStream = mocks.createWebSocketStream.mock.results.at(-1)?.value;
    oldStream.writable.abort.mockReturnValue(new Promise(() => {}));

    void connection.captureGeneration().invalidate();
    await connection.getClient();
    const replacementCallbacks = await latestCallbacks();
    const payload = sessionUpdatePayload("session-1");
    await oldCallbacks.sessionUpdate?.(payload);
    expect(received).not.toHaveBeenCalled();
    expect(intercepted).not.toHaveBeenCalled();

    await replacementCallbacks.sessionUpdate?.(payload);
    expect(received).toHaveBeenCalledOnce();
    expect(intercepted).toHaveBeenCalledOnce();
    expect(received.mock.calls[0]?.[0].sessionId).toBe(
      compositeSessionId(backendId, "session-1"),
    );
    stop();
  });

  it("rewrites remote notification session ids to composite ids", async () => {
    const conn = await importConnection();
    const received: SessionNotification[] = [];
    conn.setNotificationHandler({
      handleSessionNotification: async (notification) => {
        received.push(notification);
      },
    });

    await conn.getBackendClient("ssh:dev-box");
    const callbacks = await latestCallbacks();
    await callbacks.sessionUpdate?.(sessionUpdatePayload("20260828_2"));

    expect(received).toHaveLength(1);
    expect(received[0]?.sessionId).toBe("ssh:dev-box#20260828_2");
  });

  it("passes local notifications through byte-identical", async () => {
    const conn = await importConnection();
    const received: SessionNotification[] = [];
    conn.setNotificationHandler({
      handleSessionNotification: async (notification) => {
        received.push(notification);
      },
    });

    await conn.getClient();
    const callbacks = await latestCallbacks();
    const payload = sessionUpdatePayload("20260828_2");
    await callbacks.sessionUpdate?.(payload);

    expect(received).toHaveLength(1);
    // Local stays a passthrough: the very same object, not a copy.
    expect(received[0]).toBe(payload);
  });

  it("interceptors see the composite id for remote notifications", async () => {
    const conn = await importConnection();
    const intercepted: string[] = [];
    const stop = conn.interceptSessionNotifications((notification) => {
      intercepted.push(notification.sessionId);
      return true;
    });
    const handler = vi.fn();
    conn.setNotificationHandler({ handleSessionNotification: handler });

    await conn.getBackendClient("ssh:dev-box");
    const callbacks = await latestCallbacks();
    await callbacks.sessionUpdate?.(sessionUpdatePayload("20260828_2"));

    expect(intercepted).toEqual(["ssh:dev-box#20260828_2"]);
    expect(handler).not.toHaveBeenCalled();
    stop();
  });

  it("rewrites remote permission request session ids to composite ids", async () => {
    const conn = await importConnection();
    const seen: string[] = [];
    conn.setPermissionHandler(async (request) => {
      seen.push(request.sessionId);
      return {
        outcome: { outcome: "selected", optionId: "approve" },
      };
    });

    await conn.getBackendClient("ssh:dev-box");
    const callbacks = await latestCallbacks();
    await callbacks.requestPermission?.({
      sessionId: "20260828_2",
      options: [],
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any);

    expect(seen).toEqual(["ssh:dev-box#20260828_2"]);
  });
});
