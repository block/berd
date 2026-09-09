import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitSystemInheritedQueuedMessage } from "../lib/admittedSend";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  loadPersistedMessageQueues,
  persistMessageQueues,
} from "./queuePersistence";
import { useChatSessionStore, type ChatSession } from "./chatSessionStore";

describe("queuePersistence", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    window.localStorage.clear();
    window.__TAURI_INTERNALS__ = {};
    useChatSessionStore.setState({ sessions: [] });
  });

  it("loads inline image attachments from native persistence when localStorage is over quota", async () => {
    const serialized = JSON.stringify({
      s1: [
        {
          kind: "transport-ready",
          recordId: "queued-image",
          payload: {
            text: "inspect this",
            executionTarget: { harnessId: "goose" },
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
            payload: {
              text: "original",
              executionTarget: { harnessId: "goose" },
            },
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
            payload: {
              text: "first message",
              executionTarget: { harnessId: "goose" },
              showInComposer: false,
            },
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

  it("keeps restored transport-only voice coordination hidden", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "emissary-coordination",
            payload: {
              text: "[Handoff handoff-3 from spokesperson; cursor 3] Check this",
              showInComposer: false,
              sendOptions: {
                userMessageMetadata: {
                  origin: "voice_conversation",
                  userVisible: false,
                },
              },
            },
          },
        ],
      }),
    );

    await expect(loadPersistedMessageQueues()).resolves.toMatchObject({
      s1: [
        {
          payload: {
            showInComposer: false,
            sendOptions: {
              userMessageMetadata: { userVisible: false },
            },
          },
          restored: true,
        },
      ],
    });
  });

  it("strips legacy provider/model fields without losing the prompt", async () => {
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
      persona: { kind: "inherit" },
    });
  });

  it("strips all obsolete legacy model fields while retaining records", async () => {
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
    expect(queues.s1).toHaveLength(2);
    expect(queues.s1?.map((record) => record.payload)).toEqual([
      { text: "use the live target", persona: { kind: "inherit" } },
      { text: "keep the loaded model", persona: { kind: "inherit" } },
    ]);
  });

  it("rejects malformed persona intent instead of guessing", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "bad-persona",
            payload: {
              text: "do not guess",
              persona: { kind: "persona" },
              executionTarget: { harnessId: "goose" },
            },
          },
        ],
      }),
    );

    await expect(loadPersistedMessageQueues()).resolves.toEqual({});
  });

  it("restores targetless transport records with explicit persona intent", async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        s1: [
          {
            kind: "transport-ready",
            recordId: "missing-target",
            payload: { text: "do not infer", personaId: null },
          },
        ],
      }),
    );

    await expect(loadPersistedMessageQueues()).resolves.toMatchObject({
      s1: [
        {
          recordId: "missing-target",
          restored: true,
          payload: { text: "do not infer", persona: { kind: "none" } },
        },
      ],
    });
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
            payload: { text: "main", executionTarget: { harnessId: "goose" } },
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
            payload: admitSystemInheritedQueuedMessage({
              text: "detached",
            }),
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

  it("drops queue writes for sessions whose creation has not settled", async () => {
    mockInvoke.mockResolvedValue(undefined);
    useChatSessionStore.setState({
      sessions: [
        { id: "draft-1", creationState: "pending" } as unknown as ChatSession,
        { id: "draft-2", creationState: "failed" } as unknown as ChatSession,
      ],
    });

    persistMessageQueues(
      {
        "draft-1": [
          {
            kind: "transport-ready",
            recordId: "pending-record",
            payload: admitSystemInheritedQueuedMessage({ text: "pending" }),
          },
        ],
        "draft-2": [
          {
            kind: "transport-ready",
            recordId: "failed-record",
            payload: admitSystemInheritedQueuedMessage({ text: "failed" }),
          },
        ],
      },
      ["draft-1", "draft-2"],
    );

    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("persist_message_queue_updates", {
        serializedUpdates: JSON.stringify({ "draft-1": null, "draft-2": null }),
      }),
    );
    expect(
      window.localStorage.getItem("goose:chat-message-queues:v1"),
    ).toBeNull();
  });

  it("persists queues again once the session id belongs to a settled session", async () => {
    mockInvoke.mockResolvedValue(undefined);
    useChatSessionStore.setState({
      sessions: [{ id: "backend-1" } as unknown as ChatSession],
    });

    persistMessageQueues(
      {
        "backend-1": [
          {
            kind: "transport-ready",
            recordId: "promoted-record",
            payload: admitSystemInheritedQueuedMessage({ text: "promoted" }),
          },
        ],
      },
      ["backend-1"],
    );

    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("persist_message_queue_updates", {
        serializedUpdates: expect.stringContaining("promoted-record"),
      }),
    );
  });

  it("writes only changed sessions through native read-modify-write persistence", async () => {
    mockInvoke.mockResolvedValue(undefined);
    persistMessageQueues(
      {
        s1: [
          {
            kind: "transport-ready",
            recordId: "queued-image",
            payload: admitSystemInheritedQueuedMessage({
              text: "inspect this",
            }),
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
              payload: admitSystemInheritedQueuedMessage({
                text: "inspect this",
              }),
            },
          ],
        }),
      }),
    );
  });
});
