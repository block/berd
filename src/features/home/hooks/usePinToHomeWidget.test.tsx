import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "@/features/layout/api/layout";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "../stores/homeWidgetStore";
import {
  choosePinPlacementCenter,
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
  vi.mocked(getLayout).mockReset();
  vi.mocked(saveLayoutItems).mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
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
});
