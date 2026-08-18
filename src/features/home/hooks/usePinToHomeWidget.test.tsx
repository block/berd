import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "@/features/layout/api/layout";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { homeWidgetsToLayoutItems } from "../lib/homeLayoutMapper";
import { resetHomePinTelemetryForTests } from "../lib/homePinTelemetry";
import {
  trackHomeItemPinned,
  trackHomeItemUnpinned,
} from "../lib/homeTelemetry";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "../stores/homeWidgetStore";
import type { WidgetInstance } from "../widgets/types";
import {
  choosePinPlacementCenter,
  usePinBatchToHome,
  usePinToHomeWidget,
} from "./usePinToHomeWidget";

const ONBOARDING_STICKIES_SEEDED_STORAGE_KEY =
  "goose:home:onboarding-stickies-seeded";

vi.mock("@/features/layout/api/layout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/layout/api/layout")>();
  return {
    ...actual,
    getLayout: vi.fn(),
    saveLayoutItems: vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../lib/homeTelemetry", () => ({
  trackHomeItemPinned: vi.fn(),
  trackHomeItemUnpinned: vi.fn(),
}));

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    layoutId: HOME_LAYOUT_ID,
    itemRevision: 1,
    cameraRevision: 1,
    camera: { centerX: 50, centerY: 60, zoomBps: 10_000 },
    constraints: {
      minCenter: -100_000,
      maxCenter: 100_000,
      minSize: 1,
      maxSize: 10_000,
      minZoomBps: 1_000,
      maxZoomBps: 20_000,
      maxTitleOverrideLength: 120,
      maxItems: 100,
    },
    items: [
      {
        id: "clock-1",
        kind: "clock",
        targetId: "widget:clock-1",
        centerX: 240,
        centerY: 240,
        width: 240,
        height: 240,
        zIndex: 1,
        titleOverride: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  resetHomePinTelemetryForTests();
  useChatSessionStore.setState({ sessions: [] });
  vi.mocked(getLayout).mockReset();
  vi.mocked(saveLayoutItems).mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(trackHomeItemPinned).mockClear();
  vi.mocked(trackHomeItemUnpinned).mockClear();
  localStorage.clear();
  localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "6");
});

describe("usePinToHomeWidget", () => {
  it("chooses the viewport center when the pin will not overlap existing widgets", () => {
    expect(
      choosePinPlacementCenter({
        constraints: layout().constraints,
        instances: [],
        type: "chatPin",
        viewportCenter: { x: 120, y: 96 },
      }),
    ).toEqual({ x: 118, y: 88 });
  });

  it("chooses a nearby open spot when the viewport center is occupied", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const existingPin = {
      id: "existing-pin",
      type: "chatPin",
      x: -96,
      y: -48,
      z: 1,
      width: 188,
      height: 80,
      state: { sessionId: "session-1" },
    };

    try {
      const placement = choosePinPlacementCenter({
        constraints: layout().constraints,
        instances: [existingPin],
        type: "chatPin",
        viewportCenter: { x: 0, y: 0 },
      });

      const padding = 24;
      const placedPin = {
        x: placement.x - 94,
        y: placement.y - 40,
        width: 188,
        height: 80,
      };
      const overlapsExistingPin =
        placedPin.x < existingPin.x + existingPin.width + padding &&
        placedPin.x + placedPin.width + padding > existingPin.x &&
        placedPin.y < existingPin.y + existingPin.height + padding &&
        placedPin.y + placedPin.height + padding > existingPin.y;

      expect(placement).not.toEqual({ x: -2, y: -8 });
      expect(overlapsExistingPin).toBe(false);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("initializes the home layout and adds a matching pin widget", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());
    vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
      ok: true,
      layout: layout({ itemRevision: 2, items: request.items }),
    }));

    const { result } = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "session-1" }),
    );

    await act(async () => {
      await result.current.pinToHome();
    });

    await waitFor(() => expect(result.current.isPinned).toBe(true));
    expect(saveLayoutItems).toHaveBeenCalledWith(
      expect.objectContaining({
        layoutId: HOME_LAYOUT_ID,
        expectedRevision: 1,
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "session",
            targetId: "session-1",
          }),
        ]),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("widgets.pinToHome.success");
  });

  it("does not add a duplicate pin for the same target", async () => {
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "session-1" },
        },
      ],
      loadStatus: "ready",
      itemRevision: 1,
      cameraRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      constraints: layout().constraints,
    });

    const { result } = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "session-1" }),
    );

    expect(result.current.isPinned).toBe(true);

    await act(async () => {
      await result.current.pinToHome();
    });

    expect(saveLayoutItems).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("treats a migrated Berd app skill as the existing legacy skill pin", () => {
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "skill-pin-1",
          type: "skillPin",
          x: 0,
          y: 0,
          z: 1,
          state: {
            skillId: "global:/Users/test/.agents/skills/agent-builder",
          },
        },
      ],
      loadStatus: "ready",
      itemRevision: 1,
      cameraRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      constraints: layout().constraints,
    });

    const { result } = renderHook(() =>
      usePinToHomeWidget({
        kind: "skill",
        id: "app:/Users/test/Library/Application Support/xyz.block.berd/skills/agent-builder",
        legacyIds: ["global:/Users/test/.agents/skills/agent-builder"],
      }),
    );

    expect(result.current.isPinned).toBe(true);
  });

  it("treats either of multiple historical pin ids as the existing pin", () => {
    // A skill can accumulate more than one legacy alias (a pre-#974
    // Personal-skill migration, plus a rename retiring an old-named copy
    // from a second legacy location). A pin on the *older* of the two
    // aliases must still resolve.
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "skill-pin-1",
          type: "skillPin",
          x: 0,
          y: 0,
          z: 1,
          state: {
            skillId: "global:/Users/test/.berd/skills/goose-help",
          },
        },
      ],
      loadStatus: "ready",
      itemRevision: 1,
      cameraRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      constraints: layout().constraints,
    });

    const { result } = renderHook(() =>
      usePinToHomeWidget({
        kind: "skill",
        id: "app:/Users/test/Library/Application Support/xyz.block.berd/skills/berd-help",
        legacyIds: [
          "global:/Users/test/.agents/skills/goose-help",
          "global:/Users/test/.berd/skills/goose-help",
        ],
      }),
    );

    expect(result.current.isPinned).toBe(true);
  });

  it("removes the matching home pin when unpinning", async () => {
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "session-1" },
        },
      ],
      loadStatus: "ready",
      itemRevision: 1,
      cameraRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      constraints: layout().constraints,
    });

    const { result } = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "session-1" }),
    );

    expect(result.current.isPinned).toBe(true);

    act(() => {
      result.current.unpinFromHome();
    });

    await waitFor(() => expect(result.current.isPinned).toBe(false));
    expect(useHomeWidgetStore.getState().instances).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith("widgets.unpinFromHome.success");
  });

  it("reports a pin only once the layout save is confirmed", async () => {
    seedReadyStore([]);
    type PendingSave = {
      items: Parameters<typeof saveLayoutItems>[0]["items"];
      resolve: (result: Awaited<ReturnType<typeof saveLayoutItems>>) => void;
    };
    let pendingSave: PendingSave | null = null;
    vi.mocked(saveLayoutItems).mockImplementation(
      (request) =>
        new Promise((resolve) => {
          pendingSave = { items: request.items, resolve };
        }),
    );

    const { result } = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "session-1" }),
    );

    await act(async () => {
      await result.current.pinToHome();
    });

    await waitFor(() => expect(pendingSave).not.toBeNull());
    // The canvas already shows the pin, but nothing is persisted yet.
    expect(result.current.isPinned).toBe(true);
    expect(trackHomeItemPinned).not.toHaveBeenCalled();

    const save = pendingSave as unknown as PendingSave;
    await act(async () => {
      save.resolve({
        ok: true,
        layout: layout({ itemRevision: 2, items: save.items }),
      });
    });

    await waitFor(() => expect(trackHomeItemPinned).toHaveBeenCalledOnce());
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("reports no pin when the save fails and the canvas rolls back", async () => {
    seedReadyStore([]);
    vi.mocked(saveLayoutItems).mockRejectedValue(new Error("save failed"));

    const { result } = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "session-1" }),
    );

    await act(async () => {
      await result.current.pinToHome();
    });

    // The rollback restores the last confirmed layout, which has no pin.
    await waitFor(() => expect(result.current.isPinned).toBe(false));
    expect(useHomeWidgetStore.getState().instances).toEqual([]);
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
  });

  it("reports the pin that landed when the unpin queued behind it fails", async () => {
    seedReadyStore([]);
    type PendingSave = {
      items: Parameters<typeof saveLayoutItems>[0]["items"];
      resolve: (result: Awaited<ReturnType<typeof saveLayoutItems>>) => void;
    };
    let pendingSave: PendingSave | null = null;
    vi.mocked(saveLayoutItems)
      .mockImplementationOnce(
        (request) =>
          new Promise((resolve) => {
            pendingSave = { items: request.items, resolve };
          }),
      )
      .mockRejectedValue(new Error("save failed"));

    const { result } = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "session-1" }),
    );

    await act(async () => {
      await result.current.pinToHome();
    });
    await waitFor(() => expect(pendingSave).not.toBeNull());

    // The user changes their mind while the pin's save is still in flight, so
    // the removal is queued behind it.
    act(() => {
      result.current.unpinFromHome();
    });
    expect(result.current.isPinned).toBe(false);

    const save = pendingSave as unknown as PendingSave;
    await act(async () => {
      save.resolve({
        ok: true,
        layout: layout({ itemRevision: 2, items: save.items }),
      });
    });

    // The pin is confirmed; the unpin behind it fails, and the rollback
    // restores the confirmed layout — so the item is durably pinned.
    await waitFor(() => expect(result.current.isPinned).toBe(true));
    await waitFor(() => expect(trackHomeItemPinned).toHaveBeenCalledOnce());
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("reports no unpin when a revision conflict keeps the pin", async () => {
    const pins = [chatPin("session-1"), chatPin("session-2")];
    seedReadyStore(pins);
    // A conflict merges only additions forward, so the removal never lands:
    // the backend layout still carries the pin the user just removed.
    vi.mocked(saveLayoutItems).mockResolvedValue({
      ok: false,
      reason: "revisionConflict",
      layout: layout({
        itemRevision: 9,
        items: homeWidgetsToLayoutItems(pins),
      }),
    });

    const { result } = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "session-1" }),
    );

    expect(result.current.isPinned).toBe(true);
    act(() => {
      result.current.unpinFromHome();
    });
    expect(result.current.isPinned).toBe(false);

    await waitFor(() => expect(result.current.isPinned).toBe(true));
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
  });

  it("rewrites chat pins from a draft session id to the backend session id", () => {
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "draft-session" },
        },
        {
          id: "agent-pin-1",
          type: "agentPin",
          x: 100,
          y: 0,
          z: 2,
          state: { agentId: "agent-1" },
        },
      ],
      loadStatus: "ready",
      itemRevision: 1,
      cameraRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      constraints: layout().constraints,
    });

    act(() => {
      useHomeWidgetStore
        .getState()
        .replaceChatPinSessionId("draft-session", "backend-session");
    });

    expect(useHomeWidgetStore.getState().instances).toEqual([
      expect.objectContaining({
        id: "chat-pin-1",
        state: { sessionId: "backend-session" },
      }),
      expect.objectContaining({
        id: "agent-pin-1",
        state: { agentId: "agent-1" },
      }),
    ]);
  });

  it("reports a pinned draft chat immediately and pairs the unpin across promotion", async () => {
    seedReadyStore([]);
    mockConfirmedSaves();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-1",
          clientSessionId: "draft-1",
          creationState: "pending",
          title: "New chat",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    const draftPin = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "draft-1" }),
    );

    await act(async () => {
      await draftPin.result.current.pinToHome();
    });

    // Persisted under the draft id the first send is about to rewrite — which
    // no longer matters: no id rides the event, so the pin reports as soon as
    // it survives persistence.
    await waitFor(() =>
      expect(
        useHomeWidgetStore.getState().lastConfirmedLayout?.items,
      ).toHaveLength(1),
    );
    await waitFor(() => expect(trackHomeItemPinned).toHaveBeenCalledOnce());
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });

    // First send: the draft becomes a real session and its pin is rewritten.
    await act(async () => {
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-1", "backend-1");
      useHomeWidgetStore
        .getState()
        .replaceChatPinSessionId("draft-1", "backend-1");
    });

    // The surfaces now know the chat by its backend id; the unpin still
    // resolves as an act on the entity the reported pin was for.
    const promotedPin = renderHook(() =>
      usePinToHomeWidget({ kind: "chat", id: "backend-1" }),
    );
    expect(promotedPin.result.current.isPinned).toBe(true);

    act(() => {
      promotedPin.result.current.unpinFromHome();
    });

    await waitFor(() => expect(trackHomeItemUnpinned).toHaveBeenCalledOnce());
    expect(trackHomeItemUnpinned).toHaveBeenCalledWith({ kind: "chat" });
    // The promotion's in-place rewrite of the pin never read as a second pin.
    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
  });
});

function chatPin(sessionId: string): WidgetInstance {
  return {
    id: `chat-pin-${sessionId}`,
    type: "chatPin",
    x: 0,
    y: 0,
    z: 1,
    state: { sessionId },
  };
}

function seedReadyStore(instances: WidgetInstance[]) {
  useHomeWidgetStore.setState({
    instances,
    loadStatus: "ready",
    itemRevision: 1,
    cameraRevision: 1,
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
    constraints: layout().constraints,
    // Pin telemetry resolves against the confirmed layout, so the seeded
    // canvas has to be backed by one.
    lastConfirmedLayout: layout({ items: homeWidgetsToLayoutItems(instances) }),
  });
}

function mockConfirmedSaves() {
  vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
    ok: true,
    layout: layout({ itemRevision: 2, items: request.items }),
  }));
}

describe("usePinBatchToHome", () => {
  it("emits one Unpinned per removed item on bulk unpin, skipping duplicate and unpinned ids", async () => {
    seedReadyStore([
      chatPin("session-1"),
      chatPin("session-2"),
      {
        id: "agent-pin-1",
        type: "agentPin",
        x: 100,
        y: 0,
        z: 2,
        state: { agentId: "agent-1" },
      },
    ]);
    mockConfirmedSaves();

    const { result } = renderHook(() => usePinBatchToHome());

    act(() => {
      result.current.unpinBatchFromHome("chat", [
        "session-1",
        "session-1",
        "session-2",
        "session-3",
      ]);
    });

    // One event per removed item; with no id on the event, the call count is
    // what carries the per-item semantics.
    await waitFor(() => expect(trackHomeItemUnpinned).toHaveBeenCalledTimes(2));
    expect(trackHomeItemUnpinned).toHaveBeenCalledWith({ kind: "chat" });
    expect(useHomeWidgetStore.getState().instances).toEqual([
      expect.objectContaining({ id: "agent-pin-1" }),
    ]);
    expect(toast.success).toHaveBeenCalledWith(
      "widgets.unpinBatchFromHome.success",
    );
  });

  it("emits nothing on bulk unpin when the layout is not ready", async () => {
    useHomeWidgetStore.setState({
      instances: [chatPin("session-1")],
      loadStatus: "loading",
    });

    const { result } = renderHook(() => usePinBatchToHome());

    act(() => {
      result.current.unpinBatchFromHome("chat", ["session-1"]);
    });

    await act(async () => {});
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
    expect(useHomeWidgetStore.getState().instances).toEqual([
      expect.objectContaining({ id: "chat-pin-session-1" }),
    ]);
    expect(toast.error).toHaveBeenCalledWith(
      "widgets.unpinBatchFromHome.error",
    );
  });

  it("emits one Pinned per newly pinned item on bulk pin, skipping already-pinned ids", async () => {
    seedReadyStore([chatPin("session-1")]);
    mockConfirmedSaves();

    const { result } = renderHook(() => usePinBatchToHome());

    await act(async () => {
      await result.current.pinBatchToHome("chat", [
        "session-1",
        "session-2",
        "session-3",
      ]);
    });

    // Two newly pinned items, one event each; the already-pinned id is what
    // the count of two (not three) pins down.
    await waitFor(() => expect(trackHomeItemPinned).toHaveBeenCalledTimes(2));
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
    expect(useHomeWidgetStore.getState().instances).toHaveLength(3);
  });
});
