import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const urlRequests: Array<{ resolve: (url: string) => void }> = [];
  const initializations: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const streams: Array<{ writable: { abort: ReturnType<typeof vi.fn> } }> = [];
  class MockGooseClient {
    closed = new Promise<void>(() => {});
    async initialize(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        initializations.push({ resolve, reject }),
      );
    }
  }
  return { urlRequests, initializations, streams, MockGooseClient };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    () => new Promise<string>((resolve) => mocks.urlRequests.push({ resolve })),
  ),
}));
vi.mock("@aaif/goose-sdk", () => ({
  DEFAULT_GOOSE_MCP_HOST_CAPABILITIES: {},
  GooseClient: mocks.MockGooseClient,
}));
vi.mock("./createWebSocketStream", () => ({
  createWebSocketStream: (url: string) => {
    const stream = {
      url,
      writable: { abort: vi.fn().mockResolvedValue(undefined) },
    };
    mocks.streams.push(stream);
    return stream;
  },
}));
describe("ACP connection lifecycle", () => {
  beforeEach(() => {
    mocks.urlRequests.length = 0;
    mocks.initializations.length = 0;
    mocks.streams.length = 0;
    vi.resetModules();
  });
  it("rejects a retired URL lookup before opening its transport", async () => {
    const connection = await import("./acpConnection");
    const stale = connection.getClient();
    await vi.waitFor(() => expect(mocks.urlRequests).toHaveLength(1));

    await connection.invalidateClientConnection();
    const retry = connection.getClient();
    await vi.waitFor(() => expect(mocks.urlRequests).toHaveLength(2));
    mocks.urlRequests[0]?.resolve("ws://stale");
    await expect(stale).rejects.toThrow("initialization was superseded");
    expect(mocks.streams).toHaveLength(0);

    mocks.urlRequests[1]?.resolve("ws://current");
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(1));
    mocks.initializations[0]?.resolve();
    await expect(retry).resolves.toBeTruthy();
    expect(mocks.streams).toHaveLength(1);
    expect(mocks.streams[0]).toMatchObject({ url: "ws://current" });
  });

  it("retires and aborts an initializing transport before retry", async () => {
    const connection = await import("./acpConnection");
    const stale = connection.getClient();
    await vi.waitFor(() => expect(mocks.urlRequests).toHaveLength(1));
    mocks.urlRequests[0]?.resolve("ws://goose");
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(1));
    await connection.invalidateClientConnection();
    expect(mocks.streams[0]?.writable.abort).toHaveBeenCalledOnce();
    const retry = connection.getClient();
    await vi.waitFor(() => expect(mocks.urlRequests).toHaveLength(2));
    mocks.urlRequests[1]?.resolve("ws://goose-retry");
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(2));
    mocks.initializations[1]?.resolve();
    const client = await retry;
    mocks.initializations[0]?.resolve();
    await expect(stale).rejects.toThrow(
      "ACP connection initialization was superseded",
    );
    expect(connection.getClientSync()).toBe(client);
    expect(mocks.streams[1]?.writable.abort).not.toHaveBeenCalled();
  });

  it("rejects every waiter for a retired initialization", async () => {
    const connection = await import("./acpConnection");
    const first = connection.getClient();
    const second = connection.getClient();
    await vi.waitFor(() => expect(mocks.urlRequests).toHaveLength(1));
    mocks.urlRequests[0]?.resolve("ws://goose");
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(1));

    await connection.invalidateClientConnection();
    mocks.initializations[0]?.resolve();

    await expect(first).rejects.toThrow("initialization was superseded");
    await expect(second).rejects.toThrow("initialization was superseded");
    expect(mocks.streams[0]?.writable.abort).toHaveBeenCalledOnce();
  });

  it("aborts a transport when initialization rejects and preserves the error", async () => {
    const connection = await import("./acpConnection");
    const failed = connection.getClient();
    await vi.waitFor(() => expect(mocks.urlRequests).toHaveLength(1));
    mocks.urlRequests[0]?.resolve("ws://goose");
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(1));

    mocks.initializations[0]?.reject(new Error("handshake failed"));

    await expect(failed).rejects.toThrow("handshake failed");
    expect(mocks.streams[0]?.writable.abort).toHaveBeenCalledOnce();
    expect(connection.getClientSync()).toBeNull();

    const retry = connection.getClient();
    await vi.waitFor(() => expect(mocks.urlRequests).toHaveLength(2));
    mocks.urlRequests[1]?.resolve("ws://goose-retry");
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(2));
    mocks.initializations[1]?.resolve();
    await expect(retry).resolves.toBeTruthy();
    expect(mocks.streams[1]?.writable.abort).not.toHaveBeenCalled();
  });
});
