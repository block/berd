import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout, LayoutItem } from "@/features/layout/api/layout";
import { HOME_LAYOUT_ID } from "@/features/layout/api/layout";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  HOME_WIDGET_SAVE_CONFIRMED_EVENT,
  HOME_WIDGET_SAVE_DISCARDED_EVENT,
} from "@/features/home/onboarding/homeWidgetSaveLifecycle";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "../stores/homeWidgetStore";
import type { WidgetInstance } from "../widgets/types";
import { homeWidgetsToLayoutItems } from "./homeLayoutMapper";
import {
  recordHomeItemPinIntent,
  recordHomeItemUnpinIntent,
  resetHomePinTelemetryForTests,
} from "./homePinTelemetry";
import { trackHomeItemPinned, trackHomeItemUnpinned } from "./homeTelemetry";

vi.mock("./homeTelemetry", () => ({
  trackHomeItemPinned: vi.fn(),
  trackHomeItemUnpinned: vi.fn(),
}));

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

function skillPin(skillId: string): WidgetInstance {
  return {
    id: "skill-pin-1",
    type: "skillPin",
    x: 0,
    y: 0,
    z: 1,
    state: { skillId },
  };
}

function layoutOf(instances: WidgetInstance[]): Layout {
  return {
    layoutId: HOME_LAYOUT_ID,
    itemRevision: 1,
    cameraRevision: 1,
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
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
    items: homeWidgetsToLayoutItems(instances),
  };
}

/** The layout the backend has confirmed; local edits never change it. */
function setConfirmedLayout(instances: WidgetInstance[]): void {
  useHomeWidgetStore.setState({
    instances,
    loadStatus: "ready",
    itemRevision: 1,
    lastConfirmedLayout: layoutOf(instances),
  });
}

/**
 * A confirmed layout that `layoutItemsToHomeWidgets` cannot map: the item is not
 * a layout item at all, so mapping it throws. The real seam the containment has
 * to survive — the gate maps the whole confirmed layout on every record and
 * flush.
 */
function setUnmappableConfirmedLayout(): void {
  useHomeWidgetStore.setState({
    loadStatus: "ready",
    itemRevision: 1,
    lastConfirmedLayout: {
      ...layoutOf([]),
      items: [null as unknown as LayoutItem],
    },
  });
}

/** A chat session still waiting for its backend session to be created. */
function draftSession(id: string): ChatSession {
  return {
    id,
    clientSessionId: id,
    creationState: "pending",
    title: "New chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
  };
}

/** The same session after promotion: backend id, draft id kept as the client id. */
function promotedSession(draftId: string, backendId: string): ChatSession {
  return {
    ...draftSession(draftId),
    id: backendId,
    clientSessionId: draftId,
    creationState: undefined,
  };
}

function setSessions(sessions: ChatSession[]): void {
  useChatSessionStore.setState({ sessions });
}

function settleSave(outcome: "confirmed" | "discarded"): void {
  window.dispatchEvent(
    new Event(
      outcome === "confirmed"
        ? HOME_WIDGET_SAVE_CONFIRMED_EVENT
        : HOME_WIDGET_SAVE_DISCARDED_EVENT,
    ),
  );
}

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  resetHomePinTelemetryForTests();
  setSessions([]);
  vi.mocked(trackHomeItemPinned).mockClear();
  vi.mocked(trackHomeItemUnpinned).mockClear();
});

describe("homePinTelemetry", () => {
  it("reports a pin only once the confirmed layout contains it", () => {
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });

    expect(trackHomeItemPinned).not.toHaveBeenCalled();

    setConfirmedLayout([chatPin("session-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("reports nothing when a failed save rolls the pin back", () => {
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    // The rollback restores the last confirmed layout, which never had the pin.
    settleSave("discarded");

    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("reports nothing when a revision conflict keeps the unpinned item", () => {
    setConfirmedLayout([chatPin("session-1")]);

    recordHomeItemUnpinIntent({ kind: "chat", itemId: "session-1" });
    // A conflict adopts the backend layout and merges only additions forward,
    // so the removal never happened: the pin is still there.
    settleSave("discarded");

    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
  });

  it("reports an unpin once the confirmed layout drops it", () => {
    setConfirmedLayout([chatPin("session-1"), chatPin("session-2")]);

    recordHomeItemUnpinIntent({ kind: "chat", itemId: "session-1" });
    setConfirmedLayout([chatPin("session-2")]);
    settleSave("confirmed");

    expect(trackHomeItemUnpinned).toHaveBeenCalledOnce();
    expect(trackHomeItemUnpinned).toHaveBeenCalledWith({ kind: "chat" });
    expect(trackHomeItemPinned).not.toHaveBeenCalled();
  });

  it("matches a skill pin stored under its legacy id", () => {
    const legacyId = "global:/Users/test/.agents/skills/agent-builder";
    const itemId =
      "app:/Users/test/Library/Application Support/xyz.block.berd/skills/agent-builder";
    setConfirmedLayout([skillPin(legacyId)]);

    recordHomeItemUnpinIntent({ kind: "skill", itemId, legacyIds: [legacyId] });
    setConfirmedLayout([]);
    settleSave("confirmed");

    expect(trackHomeItemUnpinned).toHaveBeenCalledOnce();
    expect(trackHomeItemUnpinned).toHaveBeenCalledWith({ kind: "skill" });
  });

  it("reports nothing for a pin the user undid before the save settled", () => {
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    recordHomeItemUnpinIntent({ kind: "chat", itemId: "session-1" });
    settleSave("confirmed");

    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("reports a pin that landed even though the user has since asked to unpin it", () => {
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    // The user changes their mind, but the pin's own save is the one that
    // lands: the unpin behind it fails and the canvas rolls back to the pin.
    recordHomeItemUnpinIntent({ kind: "chat", itemId: "session-1" });
    setConfirmedLayout([chatPin("session-1")]);
    settleSave("discarded");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("reports a durable pin across a pin/unpin/re-pin sequence", () => {
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    recordHomeItemUnpinIntent({ kind: "chat", itemId: "session-1" });
    // The pin lands first, so this is the user's own earlier action arriving —
    // not another writer's layout, even though it is the opposite of what they
    // asked for last.
    setConfirmedLayout([chatPin("session-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });

    // The unpin lands, then the user pins again and that lands too. The item
    // ends durably pinned, which is what the one reported Pin Pinned says.
    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    setConfirmedLayout([]);
    settleSave("confirmed");
    setConfirmedLayout([chatPin("session-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("does not attribute a transition the user did not ask for", () => {
    setConfirmedLayout([]);

    recordHomeItemUnpinIntent({ kind: "chat", itemId: "session-1" });
    // Another writer's layout arrives with the item pinned: a real transition,
    // but the opposite of what this user asked for.
    setConfirmedLayout([chatPin("session-1")]);
    settleSave("discarded");

    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });

  it("resolves each intent exactly once", () => {
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "agent", itemId: "agent-1" });
    setConfirmedLayout([
      {
        id: "agent-pin-1",
        type: "agentPin",
        x: 0,
        y: 0,
        z: 1,
        state: { agentId: "agent-1" },
      },
    ]);
    settleSave("confirmed");
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
  });

  it("reports a confirmed pin of a still-draft chat immediately", () => {
    setSessions([draftSession("draft-1")]);
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "draft-1" });
    // The pin is persisted under an id promotion is about to rewrite — which
    // no longer matters: no id rides the event, so nothing waits for one.
    setConfirmedLayout([chatPin("draft-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });

    // First send: the draft is promoted and the pin is rewritten in place,
    // which is itself a layout save. The resolved intent is spent — the
    // rewrite must not read as a second pin.
    setSessions([promotedSession("draft-1", "backend-1")]);
    setConfirmedLayout([chatPin("backend-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();

    // The surfaces now know the chat by its backend id; the unpin still
    // resolves as an act on the same entity.
    recordHomeItemUnpinIntent({ kind: "chat", itemId: "backend-1" });
    setConfirmedLayout([]);
    settleSave("confirmed");

    expect(trackHomeItemUnpinned).toHaveBeenCalledOnce();
    expect(trackHomeItemUnpinned).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("matches a pin the confirmed layout still stores under the draft id", () => {
    setSessions([draftSession("draft-1")]);
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "draft-1" });
    setSessions([promotedSession("draft-1", "backend-1")]);
    // The pin's own save confirms before the promotion's rewrite does, so the
    // confirmed layout is a promotion behind the session store.
    setConfirmedLayout([chatPin("draft-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("reports both the pin and the unpin of a draft chat that never promotes", () => {
    setSessions([draftSession("draft-1")]);
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "draft-1" });
    setConfirmedLayout([chatPin("draft-1")]);
    settleSave("confirmed");

    recordHomeItemUnpinIntent({ kind: "chat", itemId: "draft-1" });
    setConfirmedLayout([]);
    settleSave("confirmed");

    // Each change survived its own save window, so each is a real user action
    // to count; with no id on the event there is no promotion to wait for.
    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemUnpinned).toHaveBeenCalledOnce();
  });

  it("pairs an unpin recorded under the promoted id with a pin stored under the draft id", () => {
    setSessions([draftSession("draft-1")]);
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "draft-1" });
    setConfirmedLayout([chatPin("draft-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();

    // Promotion, then the user removes the pin before the rewrite settles: the
    // unpin arrives under the backend id while the confirmed layout still
    // stores the pin under the draft id — the same entity either way.
    setSessions([promotedSession("draft-1", "backend-1")]);
    recordHomeItemUnpinIntent({ kind: "chat", itemId: "backend-1" });
    setConfirmedLayout([]);
    settleSave("confirmed");

    expect(trackHomeItemUnpinned).toHaveBeenCalledOnce();
    expect(trackHomeItemUnpinned).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("detaches the save-lifecycle listeners on reset and re-subscribes after it", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    setConfirmedLayout([]);
    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });

    resetHomePinTelemetryForTests();

    expect(removeEventListener).toHaveBeenCalledWith(
      HOME_WIDGET_SAVE_CONFIRMED_EVENT,
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      HOME_WIDGET_SAVE_DISCARDED_EVENT,
      expect.any(Function),
    );
    removeEventListener.mockRestore();

    // Detaching must not leave the gate deaf: the next intent re-subscribes.
    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    setConfirmedLayout([chatPin("session-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("reports a chat that was never a draft as an ordinary pin", () => {
    setSessions([
      {
        id: "session-1",
        title: "Old chat",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 12,
      },
    ]);
    setConfirmedLayout([]);

    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    setConfirmedLayout([chatPin("session-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("never throws out of a record, and keeps recording afterwards", () => {
    setUnmappableConfirmedLayout();

    // Both anchors run synchronously inside the pin/unpin handlers, after the
    // optimistic mutation applied: a throw here is a false failure toast, an
    // aborted half-batch, or an uncaught canvas handler error.
    expect(() =>
      recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" }),
    ).not.toThrow();
    expect(() =>
      recordHomeItemUnpinIntent({ kind: "skill", itemId: "skill-1" }),
    ).not.toThrow();

    settleSave("confirmed");

    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();

    // A dropped intent must not leave the gate broken for the next one.
    setConfirmedLayout([]);
    recordHomeItemPinIntent({ kind: "chat", itemId: "session-2" });
    setConfirmedLayout([chatPin("session-2")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).toHaveBeenCalledOnce();
    expect(trackHomeItemPinned).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("never throws out of a flush, and still spends the intent", () => {
    setConfirmedLayout([]);
    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });

    // The confirmed layout goes unreadable between recording and resolution.
    setUnmappableConfirmedLayout();
    expect(() => settleSave("confirmed")).not.toThrow();

    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();

    // Resolution is terminal even when it fails: a held-back intent would let
    // the next save's transition — possibly another window's — read as this
    // user's action arriving.
    setConfirmedLayout([chatPin("session-1")]);
    settleSave("confirmed");

    expect(trackHomeItemPinned).not.toHaveBeenCalled();
  });

  it("reports nothing when no layout has been confirmed yet", () => {
    useHomeWidgetStore.setState({ lastConfirmedLayout: null });

    recordHomeItemPinIntent({ kind: "chat", itemId: "session-1" });
    settleSave("confirmed");

    expect(trackHomeItemPinned).not.toHaveBeenCalled();
    expect(trackHomeItemUnpinned).not.toHaveBeenCalled();
  });
});
