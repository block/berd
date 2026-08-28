import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_BACKEND_ID,
  backendIdForSession,
  remoteHostFromBackendId,
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
  createWebSocketStream: vi.fn(),
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
}));

vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: 1,
}));

vi.mock("@aaif/goose-sdk", () => ({
  DEFAULT_GOOSE_MCP_HOST_CAPABILITIES: {},
  GooseClient: class {
    initialize = vi.fn(async () => {});
    closed: Promise<void>;
    resolveClosed!: () => void;
    constructor(_callbacks: unknown, _stream: unknown) {
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
  mocks.invoke.mockResolvedValue("ws://local");
  mocks.connectRemoteHost.mockResolvedValue({
    wsUrl: "ws://remote",
    httpBaseUrl: "http://remote",
    secretKey: "secret",
    localPort: 4242,
  });
  mocks.createWebSocketStream.mockImplementation(() => ({
    writable: { abort: vi.fn().mockResolvedValue(undefined) },
  }));
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
});
