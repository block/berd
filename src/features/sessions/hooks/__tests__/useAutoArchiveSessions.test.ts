import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { setAutoArchiveAfter } from "@/features/settings/lib/autoArchivePreference";
import { runAutoArchiveSweep } from "../useAutoArchiveSessions";

const mocks = vi.hoisted(() => ({
  getLayout: vi.fn(),
  getSessionInfo: vi.fn(),
  loadAllSessions: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.getSessionInfo(...args),
}));

vi.mock("@/features/layout/api/layout", () => ({
  HOME_LAYOUT_ID: "home",
  getLayout: (...args: unknown[]) => mocks.getLayout(...args),
}));

vi.mock("@/features/chat/lib/sessionWorkspaceCleanup", () => ({
  loadAllSessionsForWorkspaceCleanup: (...args: unknown[]) =>
    mocks.loadAllSessions(...args),
}));

function session(id: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    lastMessageAt: updatedAt,
    messageCount: 1,
  } satisfies ChatSession;
}

function layout(sessionIds: string[] = []) {
  return {
    layoutId: "home",
    itemRevision: 1,
    cameraRevision: 1,
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
    constraints: {
      minCenter: -100,
      maxCenter: 100,
      minSize: 1,
      maxSize: 100,
      minZoomBps: 1,
      maxZoomBps: 20_000,
      maxTitleOverrideLength: 100,
      maxItems: 100,
    },
    items: sessionIds.map((sessionId, index) => ({
      id: `pin-${sessionId}`,
      kind: "session" as const,
      targetId: sessionId,
      centerX: 0,
      centerY: 0,
      width: 1,
      height: 1,
      zIndex: index,
      titleOverride: null,
    })),
  };
}

function resetStores() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    archiveMutationBySessionId: {},
  });
  useChatStore.setState({
    queuedMessageBySession: {},
    draftsBySession: {},
    nonEmptyDraftSessionIds: new Set(),
    skillDraftsBySession: {},
    draftAttachmentsBySession: {},
    hasHydratedMessageQueues: true,
  });
  useSessionWindowStore.getState().setSnapshot([]);
  useHomeWidgetStore.setState({ instances: [] });
}

describe("runAutoArchiveSweep", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    setAutoArchiveAfter("7-days");
    mocks.getLayout.mockReset().mockResolvedValue(layout());
    mocks.getSessionInfo
      .mockReset()
      .mockImplementation((sessionId: string) => ({
        sessionId,
        title: sessionId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        messageCount: 1,
        userSetName: false,
      }));
    mocks.loadAllSessions.mockReset();
  });

  it("does nothing while disabled", async () => {
    setAutoArchiveAfter("never");
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(mocks.loadAllSessions).not.toHaveBeenCalled();
    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("waits for persisted message queues to hydrate", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatStore.setState({ hasHydratedMessageQueues: false });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("waits for the detached-window snapshot to hydrate", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useSessionWindowStore.setState({ hasLoadedSnapshot: false });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("skips sessions with a pending archive-state mutation", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatSessionStore.setState({
      sessions: [stale],
      archiveMutationBySessionId: {
        stale: {
          operationId: 1,
          desiredState: "unarchived",
          status: "pending",
        },
      },
    });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("stops before later mutations when the user disables the setting", async () => {
    const first = session("first");
    const second = session("second");
    mocks.loadAllSessions.mockResolvedValue([first, second]);
    const archiveSession = vi.fn(async (candidate: ChatSession) => {
      if (candidate.id === "first") setAutoArchiveAfter("never");
      return { ok: true };
    });

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first" }),
      expect.any(Function),
    );
  });

  it("continues after one candidate fails revalidation", async () => {
    const first = session("first");
    const second = session("second");
    mocks.loadAllSessions.mockResolvedValue([first, second]);
    mocks.getSessionInfo
      .mockRejectedValueOnce(new Error("session disappeared"))
      .mockImplementation((sessionId: string) => ({
        sessionId,
        title: sessionId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        messageCount: 1,
        userSetName: false,
      }));
    const archiveSession = vi.fn().mockResolvedValue({ ok: true });

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "second" }),
      expect.any(Function),
    );
  });

  it("provides a final guard for changes while the archive transaction waits", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    const archiveSession = vi.fn(
      async (_candidate: ChatSession, revalidate: () => Promise<boolean>) => {
        useChatSessionStore.setState({ activeSessionId: "stale" });
        expect(await revalidate()).toBe(false);
        return { ok: false };
      },
    );

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
  });

  it("skips a candidate with newer local activity than the refreshed backend row", async () => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatSessionStore.setState({
      sessions: [
        session("stale", new Date(Date.now() - 60 * 60 * 1000).toISOString()),
      ],
    });
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });

  it("skips a later candidate that becomes active", async () => {
    const first = session("first");
    const second = session("second");
    mocks.loadAllSessions.mockResolvedValue([first, second]);
    const archiveSession = vi.fn(async (candidate: ChatSession) => {
      if (candidate.id === "first") {
        useChatSessionStore.setState({ activeSessionId: "second" });
      }
      return { ok: true };
    });

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first" }),
      expect.any(Function),
    );
  });

  it("skips a later candidate that is pinned during the sweep", async () => {
    const first = session("first");
    const second = session("second");
    mocks.loadAllSessions.mockResolvedValue([first, second]);
    mocks.getLayout
      .mockResolvedValueOnce(layout())
      .mockResolvedValueOnce(layout())
      .mockResolvedValueOnce(layout(["second"]));
    const archiveSession = vi.fn().mockResolvedValue({ ok: true });

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first" }),
      expect.any(Function),
    );
  });

  it.each([
    [
      "a running session",
      () => {
        useChatStore.getState().setChatState("stale", "streaming");
        return {};
      },
    ],
    [
      "a detached window",
      () => {
        useSessionWindowStore
          .getState()
          .setSnapshot([{ sessionId: "stale", windowLabel: "session:stale" }]);
        return {};
      },
    ],
    ["composer text", () => ({ nonEmptyDraftSessionIds: new Set(["stale"]) })],
    [
      "queued message",
      () => ({
        queuedMessageBySession: { stale: [{}] },
      }),
    ],
    ["skill draft", () => ({ skillDraftsBySession: { stale: [{}] } })],
    [
      "draft attachment",
      () => ({ draftAttachmentsBySession: { stale: [{}] } }),
    ],
  ])("preserves %s", async (_label, unsafeState) => {
    const stale = session("stale");
    mocks.loadAllSessions.mockResolvedValue([stale]);
    useChatStore.setState(unsafeState() as never);
    const archiveSession = vi.fn();

    await runAutoArchiveSweep({ archiveSession });

    expect(archiveSession).not.toHaveBeenCalled();
  });
});
