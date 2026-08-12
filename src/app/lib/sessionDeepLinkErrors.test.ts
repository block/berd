import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listenSessionDeepLinkErrors,
  SESSION_DEEP_LINK_ERROR_EVENT,
} from "./sessionDeepLinkErrors";

const mockListen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

describe("listenSessionDeepLinkErrors", () => {
  beforeEach(() => {
    delete window.__TAURI_INTERNALS__;
    mockListen.mockReset();
    mockListen.mockResolvedValue(vi.fn());
  });

  it("does not subscribe outside the Tauri webview", async () => {
    const unlisten = await listenSessionDeepLinkErrors(vi.fn());

    unlisten();

    expect(mockListen).not.toHaveBeenCalled();
  });

  it("subscribes to the session deep link error event", async () => {
    const handler = vi.fn();
    const unlisten = vi.fn();
    window.__TAURI_INTERNALS__ = {};
    mockListen.mockResolvedValue(unlisten);

    const cleanup = await listenSessionDeepLinkErrors(handler);
    const [, eventHandler] = mockListen.mock.calls[0] as [
      string,
      (event: { payload: unknown }) => void,
    ];

    eventHandler({
      payload: {
        sessionId: "missing-session",
        message: 'No session "missing-session".',
      },
    });
    cleanup();

    expect(mockListen).toHaveBeenCalledWith(
      SESSION_DEEP_LINK_ERROR_EVENT,
      expect.any(Function),
    );
    expect(handler).toHaveBeenCalledWith({
      sessionId: "missing-session",
      message: 'No session "missing-session".',
    });
    expect(unlisten).toHaveBeenCalled();
  });
});
