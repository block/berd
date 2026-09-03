import { describe, expect, it, vi } from "vitest";
const eventListeners = vi.hoisted(
  () => new Map<string, Set<(event: { payload: unknown }) => void>>(),
);
const apiMocks = vi.hoisted(() => ({
  getVoiceControlsStatus: vi.fn(async () => ({
    lifecycle: "running",
    sessionId: "session-in-another-window",
  })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, listener: (event: { payload: unknown }) => void) => {
      const listeners = eventListeners.get(event) ?? new Set();
      listeners.add(listener);
      eventListeners.set(event, listeners);
      return () => listeners.delete(listener);
    },
  ),
  emit: vi.fn(async (event: string, payload: unknown) => {
    for (const listener of eventListeners.get(event) ?? []) {
      await listener({ payload });
    }
  }),
}));

vi.mock("@/shared/api/openaiRealtime", () => ({
  getOpenAiRealtimeVoiceControlsStatus: () => apiMocks.getVoiceControlsStatus(),
}));

import {
  completeActiveRealtimeMasterTurn,
  hasActiveRealtimeEmissary,
  registerRealtimeEmissary,
  sendToActiveRealtimeSpokesperson,
} from "./realtimeEmissaryBridge";

describe("realtime emissary bridge registration", () => {
  it("bounds a stalled remote voice-status lookup", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    apiMocks.getVoiceControlsStatus.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    const result = hasActiveRealtimeEmissary("remote-session");
    const expectedTimeout = expect(result).rejects.toThrow(
      "Timed out checking the OpenAI Realtime voice status.",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expectedTimeout;

    vi.useRealTimers();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  it("routes only to the current live session and releases by identity", async () => {
    const sendMasterMessage = vi.fn().mockResolvedValue({
      accepted: false,
      reason: "stale_cursor",
      cursor: 2,
    });
    const emissary = {
      sessionId: "session-1",
      sendMasterMessage,
      dismissHandoffs: vi.fn(),
      completeMasterTurn: vi.fn(),
    };
    const release = registerRealtimeEmissary(emissary);

    await expect(
      emissary.sendMasterMessage("update", 1, "context", []),
    ).resolves.toMatchObject({ accepted: false, cursor: 2 });
    await completeActiveRealtimeMasterTurn("session-1", {
      reminderHandoffIds: ["handoff-1"],
    });
    expect(emissary.completeMasterTurn).toHaveBeenCalledWith({
      reminderHandoffIds: ["handoff-1"],
    });
    await expect(hasActiveRealtimeEmissary("session-1")).resolves.toBe(true);
    await expect(hasActiveRealtimeEmissary("session-2")).resolves.toBe(false);

    release();
    await expect(hasActiveRealtimeEmissary("session-1")).resolves.toBe(false);
  });

  it("accepts a bridge response from another renderer", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const requests = eventListeners.get(
      "voice-conversation:spokesperson-bridge-request",
    );
    const remoteResponder = async ({ payload }: { payload: unknown }) => {
      const request = payload as { id: string };
      for (const listener of eventListeners.get(
        "voice-conversation:spokesperson-bridge-response",
      ) ?? []) {
        await listener({
          payload: {
            id: request.id,
            delivery: {
              accepted: false,
              reason: "stale_cursor",
              cursor: 4,
            },
          },
        });
      }
    };
    const listeners = requests ?? new Set();
    listeners.add(remoteResponder);
    eventListeners.set(
      "voice-conversation:spokesperson-bridge-request",
      listeners,
    );

    await expect(
      sendToActiveRealtimeSpokesperson(
        "session-in-another-window",
        "Answer",
        3,
        "say",
        [],
      ),
    ).resolves.toEqual({
      accepted: false,
      reason: "stale_cursor",
      cursor: 4,
    });

    listeners.delete(remoteResponder);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  it("routes a process event to the renderer that owns the Spokesperson", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const sendMasterMessage = vi.fn().mockResolvedValue({
      accepted: false,
      reason: "stale_cursor",
      cursor: 6,
    });
    const completeMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "popup-session",
      sendMasterMessage,
      dismissHandoffs: vi.fn(),
      completeMasterTurn,
    });
    await Promise.resolve();
    const responses: unknown[] = [];
    const responseListener = ({ payload }: { payload: unknown }) => {
      responses.push(payload);
    };
    const responseListeners =
      eventListeners.get("voice-conversation:spokesperson-bridge-response") ??
      new Set();
    responseListeners.add(responseListener);
    eventListeners.set(
      "voice-conversation:spokesperson-bridge-response",
      responseListeners,
    );

    for (const listener of eventListeners.get(
      "voice-conversation:spokesperson-bridge-request",
    ) ?? []) {
      await listener({
        payload: {
          id: "request-1",
          action: "send",
          sessionId: "popup-session",
          message: "Answer the user",
          cursor: 5,
          mode: "say",
          resolves: ["handoff-5"],
        },
      });
    }

    expect(sendMasterMessage).toHaveBeenCalledWith(
      "Answer the user",
      5,
      "say",
      ["handoff-5"],
    );
    expect(responses).toContainEqual({
      id: "request-1",
      delivery: {
        accepted: false,
        reason: "stale_cursor",
        cursor: 6,
      },
    });

    for (const listener of eventListeners.get(
      "voice-conversation:spokesperson-bridge-request",
    ) ?? []) {
      await listener({
        payload: {
          id: "presence-1",
          action: "hasActive",
          sessionId: "popup-session",
        },
      });
      await listener({
        payload: {
          id: "completion-1",
          action: "complete",
          sessionId: "popup-session",
          completion: { reminderHandoffIds: ["handoff-8"] },
        },
      });
    }

    expect(responses).toContainEqual({ id: "presence-1", active: true });
    expect(responses).toContainEqual({ id: "completion-1", completed: true });
    expect(completeMasterTurn).toHaveBeenCalledWith({
      reminderHandoffIds: ["handoff-8"],
    });

    responseListeners.delete(responseListener);
    release();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  it("routes presence and turn completion to another renderer", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const received: unknown[] = [];
    const ownerListener = async ({ payload }: { payload: unknown }) => {
      const request = payload as {
        id: string;
        action: "hasActive" | "complete";
        completion?: { reminderHandoffIds: string[] };
      };
      received.push(request);
      const response =
        request.action === "hasActive"
          ? { id: request.id, active: true }
          : { id: request.id, completed: true };
      for (const listener of eventListeners.get(
        "voice-conversation:spokesperson-bridge-response",
      ) ?? []) {
        await listener({ payload: response });
      }
    };
    const requests =
      eventListeners.get("voice-conversation:spokesperson-bridge-request") ??
      new Set();
    requests.add(ownerListener);
    eventListeners.set(
      "voice-conversation:spokesperson-bridge-request",
      requests,
    );

    await expect(
      hasActiveRealtimeEmissary("session-in-another-window"),
    ).resolves.toBe(true);
    await expect(
      completeActiveRealtimeMasterTurn("session-in-another-window", {
        reminderHandoffIds: ["handoff-7"],
      }),
    ).resolves.toBe(true);
    expect(received).toEqual([
      expect.objectContaining({
        action: "hasActive",
        sessionId: "session-in-another-window",
      }),
      expect.objectContaining({
        action: "complete",
        sessionId: "session-in-another-window",
        completion: { reminderHandoffIds: ["handoff-7"] },
      }),
    ]);

    requests.delete(ownerListener);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });
});
