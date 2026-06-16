import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPluginUnavailableError,
  listenGoosectlRequests,
  type BridgeRequest,
} from "@/features/goosectl/bridge/goosectlPlugin";

// Invoke forwarding for start/stop/set_timeouts/submit_result is pinned
// end-to-end in goosectlBridge.test.tsx.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const mockedListen = vi.mocked(listen);

beforeEach(() => {
  // restoreMocks only restores vi.spyOn spies; vi.fn() mocks keep their call
  // history across tests unless cleared explicitly.
  vi.clearAllMocks();
});

afterEach(() => {
  window.__TAURI_INTERNALS__ = undefined;
});

describe("listenGoosectlRequests", () => {
  it("returns a no-op unlistener outside the Tauri webview", async () => {
    window.__TAURI_INTERNALS__ = undefined;

    const unlisten = await listenGoosectlRequests(() => {});

    expect(mockedListen).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });

  it("subscribes to the request event and forwards payloads", async () => {
    window.__TAURI_INTERNALS__ = {};
    const received: BridgeRequest[] = [];
    let captured: ((event: { payload: BridgeRequest }) => void) | undefined;
    mockedListen.mockImplementation((eventName, handler) => {
      expect(eventName).toBe("goosectl:request");
      captured = handler as (event: { payload: BridgeRequest }) => void;
      return Promise.resolve(() => {});
    });

    await listenGoosectlRequests((request) => received.push(request));
    const request: BridgeRequest = {
      id: "req-1",
      command: "sessions",
      args: { prompt: "hi" },
      timeoutMs: 60_000,
    };
    captured?.({ payload: request });

    expect(mockedListen).toHaveBeenCalledTimes(1);
    expect(received).toEqual([request]);
  });
});

describe("isPluginUnavailableError", () => {
  it.each([
    "goosectl.start not allowed. Permissions associated with this command: goosectl:default",
    "Command goosectl|start not found",
    "command plugin:goosectl|start not found",
  ])("recognizes %j", (message) => {
    expect(isPluginUnavailableError(message)).toBe(true);
    expect(isPluginUnavailableError(new Error(message))).toBe(true);
  });

  it.each([
    "network down",
    "session not found",
    "failed to bind 127.0.0.1:0",
    // ACL denials and unknown commands that do not name the plugin are some
    // other surface's problem, not evidence this plugin is missing.
    "start not allowed. Permissions associated with this command: allow-start",
    "command other|start not found",
  ])("does not flag %j", (message) => {
    expect(isPluginUnavailableError(message)).toBe(false);
    expect(isPluginUnavailableError(new Error(message))).toBe(false);
  });

  it("handles non-error values", () => {
    expect(isPluginUnavailableError(undefined)).toBe(false);
    expect(isPluginUnavailableError(null)).toBe(false);
    expect(isPluginUnavailableError(42)).toBe(false);
  });
});
