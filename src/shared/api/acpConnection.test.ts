import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const initializations: Array<() => void> = [];
  const streams: Array<{ writable: { abort: ReturnType<typeof vi.fn> } }> = [];
  class MockGooseClient {
    closed = new Promise<void>(() => {});
    async initialize(): Promise<void> {
      await new Promise<void>((resolve) => initializations.push(resolve));
    }
  }
  return { initializations, streams, MockGooseClient };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("ws://goose"),
}));
vi.mock("@aaif/goose-sdk", () => ({
  DEFAULT_GOOSE_MCP_HOST_CAPABILITIES: {},
  GooseClient: mocks.MockGooseClient,
}));
vi.mock("./createWebSocketStream", () => ({
  createWebSocketStream: () => {
    const stream = {
      writable: { abort: vi.fn().mockResolvedValue(undefined) },
    };
    mocks.streams.push(stream);
    return stream;
  },
}));
describe("ACP connection lifecycle", () => {
  beforeEach(() => {
    mocks.initializations.length = 0;
    mocks.streams.length = 0;
    vi.resetModules();
  });
  it("retires and aborts an initializing transport before retry", async () => {
    const connection = await import("./acpConnection");
    const stale = connection.getClient();
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(1));
    await connection.invalidateClientConnection();
    expect(mocks.streams[0]?.writable.abort).toHaveBeenCalledOnce();
    const retry = connection.getClient();
    await vi.waitFor(() => expect(mocks.initializations).toHaveLength(2));
    mocks.initializations[1]?.();
    const client = await retry;
    mocks.initializations[0]?.();
    await stale;
    expect(connection.getClientSync()).toBe(client);
    expect(mocks.streams[1]?.writable.abort).not.toHaveBeenCalled();
  });
});
