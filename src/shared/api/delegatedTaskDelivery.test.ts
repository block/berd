import { describe, expect, it, vi } from "vitest";
import { drainDelegatedTaskEvents } from "./delegatedTaskDelivery";

const event = {
  taskId: "worker",
  parentSessionId: "owner",
  description: "Inspect parser",
  status: "action_limit_reached",
};

describe("delegated completion delivery", () => {
  it("wakes the exact idle owner using the monitor route without retrieving the result", async () => {
    const deliver = vi.fn().mockResolvedValue({ send_status: "dispatched" });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ events: [event] })
      .mockResolvedValue({});
    await drainDelegatedTaskEvents(request, "local", ["owner"], deliver);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "owner",
        if_running: "queue",
        delivery_id: "delegated-task:worker",
        prompt: expect.stringContaining("Work is incomplete"),
      }),
      { eventType: "notification" },
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "_goose/unstable/session/delegated-tasks/pending",
      "_goose/unstable/session/delegated-tasks/acknowledge",
    ]);
    expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[1],
    );
  });

  it("keeps delivery pending on rejection and retries with the same ID", async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("window handoff"))
      .mockResolvedValue({ send_status: "queued" });
    const request = vi.fn().mockResolvedValue({ events: [event] });
    await drainDelegatedTaskEvents(request, "local", ["owner"], deliver);
    expect(request).toHaveBeenCalledTimes(1);
    await drainDelegatedTaskEvents(request, "local", ["owner"], deliver);
    expect(deliver.mock.calls[0][0].delivery_id).toBe(
      deliver.mock.calls[1][0].delivery_id,
    );
    expect(request).toHaveBeenLastCalledWith(
      "_goose/unstable/session/delegated-tasks/acknowledge",
      { parentSessionId: "owner", taskId: "worker" },
    );
  });

  it("isolates backend identity and refuses unsolicited owners", async () => {
    const deliver = vi.fn().mockResolvedValue({ send_status: "queued" });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        events: [event, { ...event, parentSessionId: "other" }],
      })
      .mockResolvedValue({});
    await drainDelegatedTaskEvents(request, "ssh:box", ["owner"], deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].session_id).toBe("ssh:box#owner");
    expect(request).toHaveBeenLastCalledWith(
      "_goose/unstable/session/delegated-tasks/acknowledge",
      { parentSessionId: "owner", taskId: "worker" },
    );
  });

  it("acknowledges replay only after the monitor route deduplicates it", async () => {
    const deliver = vi.fn().mockResolvedValue({ send_status: "deduplicated" });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ events: [event] })
      .mockResolvedValue({});
    await drainDelegatedTaskEvents(request, "local", ["owner"], deliver);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
