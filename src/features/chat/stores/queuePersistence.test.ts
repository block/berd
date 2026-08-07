import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  loadPersistedMessageQueues,
  persistMessageQueues,
} from "./queuePersistence";

describe("queuePersistence", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    window.localStorage.clear();
    window.__TAURI_INTERNALS__ = {};
  });

  it("loads inline image attachments from native persistence when localStorage is over quota", async () => {
    const serialized = JSON.stringify({
      s1: [
        {
          kind: "transport-ready",
          recordId: "queued-image",
          payload: {
            text: "inspect this",
            attachments: [
              {
                id: "image-1",
                kind: "image",
                name: "large.png",
                mimeType: "image/png",
                base64: "bytes",
                previewUrl: "data:image/png;base64,bytes",
              },
            ],
          },
        },
      ],
    });
    mockInvoke.mockResolvedValue(serialized);
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    await expect(loadPersistedMessageQueues()).resolves.toMatchObject({
      s1: [
        {
          recordId: "queued-image",
          payload: { attachments: [{ base64: "bytes" }] },
        },
      ],
    });
    expect(mockInvoke).toHaveBeenCalledWith("load_message_queues");
    setItem.mockRestore();
  });

  it("clears ephemeral edit locks and parks restored queues until session replay", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "editing-record",
            payload: { text: "original" },
            editing: true,
          },
        ],
      }),
    );

    const queues = await loadPersistedMessageQueues();
    expect(queues.s1?.[0]).toMatchObject({
      recordId: "editing-record",
      restored: true,
    });
    expect(queues.s1?.[0]).not.toHaveProperty("editing");
  });

  it("reveals a hidden startup handoff when restoring it", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "hidden-startup-handoff",
            payload: { text: "first message", showInComposer: false },
          },
        ],
      }),
    );

    await expect(loadPersistedMessageQueues()).resolves.toMatchObject({
      s1: [
        {
          payload: { text: "first message", showInComposer: true },
          restored: true,
        },
      ],
    });
  });

  it("migrates legacy provider/model fields into a qualified target", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "legacy-selection",
            payload: {
              text: "continue with claude",
              providerId: "claude",
              modelId: "claude-fable",
            },
          },
        ],
      }),
    );

    const queues = await loadPersistedMessageQueues();
    expect(queues.s1?.[0]?.payload).toEqual({
      text: "continue with claude",
      executionTarget: {
        harnessId: "claude-acp",
        modelProviderId: "claude-acp",
        modelId: "claude-fable",
        modelName: "claude-fable",
      },
    });
  });

  it("drops an unqualified legacy model instead of pairing it with a provider", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "orphan-model",
            payload: { text: "use the live target", modelId: "stale-model" },
          },
          {
            kind: "transport-ready",
            recordId: "goose-sentinel-model",
            payload: {
              text: "keep the loaded model",
              providerId: "goose",
              modelId: "gpt-5.6",
            },
          },
        ],
      }),
    );

    const queues = await loadPersistedMessageQueues();
    expect(queues.s1?.map((record) => record.payload)).toEqual([
      { text: "use the live target" },
      { text: "keep the loaded model" },
    ]);
  });

  it("rejects deferred records without supported workspace-first-send state", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "deferred",
            recordId: "unsupported-deferred",
            payload: { text: "do not send" },
            state: { type: "unknown", status: "held" },
          },
        ],
      }),
    );

    await expect(loadPersistedMessageQueues()).resolves.toEqual({});
  });

  it("merges changed sessions into the fallback cache", () => {
    window.localStorage.setItem(
      "goose:chat-message-queues:v1",
      JSON.stringify({
        main: [
          {
            kind: "transport-ready",
            recordId: "main-record",
            payload: { text: "main" },
          },
        ],
      }),
    );

    persistMessageQueues(
      {
        detached: [
          {
            kind: "transport-ready",
            recordId: "detached-record",
            payload: { text: "detached" },
          },
        ],
      },
      ["detached"],
    );

    expect(
      JSON.parse(
        window.localStorage.getItem("goose:chat-message-queues:v1") ?? "{}",
      ),
    ).toMatchObject({
      main: [{ recordId: "main-record" }],
      detached: [{ recordId: "detached-record" }],
    });
  });

  it("writes only changed sessions through native read-modify-write persistence", async () => {
    mockInvoke.mockResolvedValue(undefined);
    persistMessageQueues(
      {
        s1: [
          {
            kind: "transport-ready",
            recordId: "queued-image",
            payload: { text: "inspect this" },
          },
        ],
      },
      ["s1"],
    );
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("persist_message_queue_updates", {
        serializedUpdates: JSON.stringify({
          s1: [
            {
              kind: "transport-ready",
              recordId: "queued-image",
              payload: { text: "inspect this" },
            },
          ],
        }),
      }),
    );
  });
});
