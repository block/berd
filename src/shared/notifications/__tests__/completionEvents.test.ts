import { describe, expect, it, vi } from "vitest";

import {
  createCompletionNotificationEvent,
  emitCompletionNotificationEvent,
  subscribeToCompletionNotificationEvents,
} from "../completionEvents";

describe("createCompletionNotificationEvent", () => {
  it("assigns distinct IDs to same-session events with the same timestamp", () => {
    const first = createCompletionNotificationEvent({
      sessionId: "session-1",
      outcome: "completed",
      body: "Agent finished",
      occurredAtMs: 1_750_000_000_000,
    });
    const duplicate = createCompletionNotificationEvent({
      sessionId: "session-1",
      outcome: "completed",
      body: "Agent finished",
      occurredAtMs: 1_750_000_000_000,
    });
    const other = createCompletionNotificationEvent({
      sessionId: "session-2",
      outcome: "completed",
      body: "Agent finished",
      occurredAtMs: 1_750_000_000_000,
    });

    expect(first.id).not.toBe(duplicate.id);
    expect(first.id).not.toBe(other.id);
    expect(first.occurredAt).toBe(duplicate.occurredAt);
    expect(first.occurredAt).toBe(new Date(1_750_000_000_000).toISOString());
  });

  it("carries session, project, outcome, and navigation references", () => {
    const event = createCompletionNotificationEvent({
      sessionId: "session-1",
      projectId: "project-9",
      outcome: "error",
      body: "Agent encountered an error",
      occurredAtMs: 1_750_000_000_000,
    });

    expect(event).toMatchObject({
      sessionId: "session-1",
      projectId: "project-9",
      outcome: "error",
      body: "Agent encountered an error",
      navigation: { kind: "session", sessionId: "session-1" },
    });
    expect(event.occurredAt).toBe(new Date(1_750_000_000_000).toISOString());
  });

  it("defaults projectId to null for unattached sessions", () => {
    const event = createCompletionNotificationEvent({
      sessionId: "session-1",
      outcome: "stopped",
      body: "Agent was stopped",
      occurredAtMs: 1,
    });
    expect(event.projectId).toBeNull();
  });
});

describe("completion notification event bus", () => {
  it("delivers events to subscribers and honors unsubscribe", () => {
    const seen = vi.fn();
    const unsubscribe = subscribeToCompletionNotificationEvents(seen);
    const event = createCompletionNotificationEvent({
      sessionId: "session-1",
      outcome: "completed",
      body: "Agent finished",
      occurredAtMs: 2,
    });

    emitCompletionNotificationEvent(event);
    expect(seen).toHaveBeenCalledExactlyOnceWith(event);

    unsubscribe();
    emitCompletionNotificationEvent(event);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("isolates listener failures from other listeners", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const unsubscribeThrowing = subscribeToCompletionNotificationEvents(() => {
      throw new Error("listener exploded");
    });
    const healthy = vi.fn();
    const unsubscribeHealthy = subscribeToCompletionNotificationEvents(healthy);

    emitCompletionNotificationEvent(
      createCompletionNotificationEvent({
        sessionId: "session-1",
        outcome: "completed",
        body: "Agent finished",
        occurredAtMs: 3,
      }),
    );

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    unsubscribeThrowing();
    unsubscribeHealthy();
    errorSpy.mockRestore();
  });
});
