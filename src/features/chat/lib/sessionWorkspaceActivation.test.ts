import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPendingSessionWorkspaceActivation,
  claimSessionWorkspaceIntent,
  clearPendingSessionWorkspaceActivation,
  getPendingSessionWorkspaceActivation,
  queueSessionWorkspaceActivation,
  supersedePendingSessionWorkspaceActivation,
} from "./sessionWorkspaceActivation";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";

const mocks = vi.hoisted(() => ({
  checkDirectoriesExist: vi.fn(),
  getGitState: vi.fn(),
  updateWorkingDir: vi.fn(),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  checkDirectoriesExist: (...args: unknown[]) =>
    mocks.checkDirectoriesExist(...args),
}));
vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
}));
vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  updateWorkingDir: (
    sessionId: string,
    path: string,
    beforeUpdate?: () => void,
  ) => {
    beforeUpdate?.();
    return mocks.updateWorkingDir(sessionId, path);
  },
}));
vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  releaseSession: vi.fn(),
}));

function session(): ChatSession {
  return {
    id: "session-1",
    title: "Chat",
    workingDir: "/tmp/main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
  };
}

describe("session workspace activation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearPendingSessionWorkspaceActivation("session-1");
    vi.clearAllMocks();
    useChatSessionStore.setState({
      sessions: [session()],
      activeWorkspaceBySession: {},
    });
    useChatStore.setState({
      sessionStateById: {},
    });
    mocks.checkDirectoriesExist.mockResolvedValue([]);
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature",
    });
    mocks.updateWorkingDir.mockResolvedValue(undefined);
  });

  it("commits backend, persisted workspace metadata, and rail state together", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });

    await expect(
      applyPendingSessionWorkspaceActivation("session-1"),
    ).resolves.toBe("/tmp/feature");

    expect(mocks.updateWorkingDir).toHaveBeenCalledWith(
      "session-1",
      "/tmp/feature",
    );
    const store = useChatSessionStore.getState();
    expect(store.getSession("session-1")?.workingDir).toBe("/tmp/feature");
    expect(store.getSession("session-1")?.activeWorkspaceId).toBe(
      "path:/tmp/feature",
    );
    expect(store.activeWorkspaceBySession["session-1"]).toEqual({
      path: "/tmp/feature",
      branch: "feature",
    });
    expect(getPendingSessionWorkspaceActivation("session-1")).toBeNull();
  });

  it("shares one commit when the idle drain and next prompt race", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });
    let releaseUpdate: (() => void) | undefined;
    mocks.updateWorkingDir.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        }),
    );

    const idleDrain = applyPendingSessionWorkspaceActivation("session-1");
    const promptBarrier = applyPendingSessionWorkspaceActivation("session-1");

    expect(idleDrain).toBe(promptBarrier);
    await vi.waitFor(() => {
      expect(mocks.updateWorkingDir).toHaveBeenCalledTimes(1);
      expect(releaseUpdate).toBeTypeOf("function");
    });
    releaseUpdate?.();
    await expect(promptBarrier).resolves.toBe("/tmp/feature");
  });

  it("upgrades an idle-owned activation when a prompt joins while running", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });
    let releaseGitState: (() => void) | undefined;
    mocks.getGitState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGitState = () =>
            resolve({ isGitRepo: true, currentBranch: "feature" });
        }),
    );

    const idleDrain = applyPendingSessionWorkspaceActivation("session-1");
    await vi.waitFor(() => expect(releaseGitState).toBeTypeOf("function"));
    useChatStore.getState().setChatState("session-1", "thinking");
    const promptBarrier = applyPendingSessionWorkspaceActivation("session-1", {
      allowRunning: true,
    });
    releaseGitState?.();

    expect(promptBarrier).toBe(idleDrain);
    await expect(promptBarrier).resolves.toBe("/tmp/feature");
    expect(mocks.updateWorkingDir).toHaveBeenCalledWith(
      "session-1",
      "/tmp/feature",
    );
  });

  it("reports the request actually attempted when a newer request is queued", async () => {
    const first = queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/one",
      branch: "one",
    });
    let rejectFirst: ((error: Error) => void) | undefined;
    mocks.updateWorkingDir.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    const barrier = applyPendingSessionWorkspaceActivation("session-1");
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
    const second = queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/two",
      branch: "two",
    });
    rejectFirst?.(new Error("backend offline"));

    await expect(barrier).rejects.toMatchObject({
      message: "backend offline",
      attemptedRequestId: first.requestId,
    });
    expect(getPendingSessionWorkspaceActivation("session-1")).toEqual(second);
  });

  it("applies a newer request before releasing an in-flight barrier", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/one",
      branch: "one",
    });
    let releaseFirst: (() => void) | undefined;
    mocks.updateWorkingDir
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const barrier = applyPendingSessionWorkspaceActivation("session-1");
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/two",
      branch: "two",
    });
    releaseFirst?.();

    await expect(barrier).resolves.toBe("/tmp/two");
    expect(mocks.updateWorkingDir.mock.calls).toEqual([
      ["session-1", "/tmp/one"],
      ["session-1", "/tmp/two"],
    ]);
    expect(
      useChatSessionStore.getState().getSession("session-1")?.workingDir,
    ).toBe("/tmp/two");
  });

  it("lets an explicit switch supersede pending intent", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });

    await supersedePendingSessionWorkspaceActivation("session-1");

    expect(getPendingSessionWorkspaceActivation("session-1")).toBeNull();
  });

  it("keeps the switch pending if the session starts before dispatch", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });
    mocks.updateWorkingDir.mockImplementationOnce(async () => {
      useChatStore.getState().setChatState("session-1", "streaming");
      throw new Error(
        "The session started running before its pending workspace switch could be applied.",
      );
    });

    await expect(
      applyPendingSessionWorkspaceActivation("session-1"),
    ).rejects.toThrow("started running");
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/tmp/feature",
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.workingDir,
    ).toBe("/tmp/main");
  });

  it("keeps a transiently failed activation pending", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/feature",
      branch: "feature",
    });
    mocks.updateWorkingDir.mockRejectedValueOnce(new Error("backend offline"));

    await expect(
      applyPendingSessionWorkspaceActivation("session-1"),
    ).rejects.toThrow("backend offline");

    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/tmp/feature",
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.workingDir,
    ).toBe("/tmp/main");
  });

  it("cancels a pending request when its folder is gone", async () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/gone",
      branch: "gone",
    });
    mocks.checkDirectoriesExist.mockResolvedValueOnce(["/tmp/gone"]);

    await expect(
      applyPendingSessionWorkspaceActivation("session-1"),
    ).rejects.toThrow("still needs a valid replacement");

    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/tmp/gone",
    });
  });

  it("lets the newest pending request replace an older one", () => {
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/one",
      branch: "one",
    });
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/tmp/two",
      branch: "two",
    });

    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/tmp/two",
      branch: "two",
    });
  });
  it("rejects an older lifecycle intent after a newer cwd intent is claimed", () => {
    const staleGeneration = claimSessionWorkspaceIntent("session-1");
    claimSessionWorkspaceIntent("session-1");

    expect(() =>
      queueSessionWorkspaceActivation({
        sessionId: "session-1",
        path: "/tmp/stale",
        branch: null,
        intentGeneration: staleGeneration,
      }),
    ).toThrow("newer session workspace intent");
    expect(getPendingSessionWorkspaceActivation("session-1")).toBeNull();
  });
  it("keeps one operation token while clearing pending activation", async () => {
    const generation = claimSessionWorkspaceIntent("session-1");
    await expect(
      supersedePendingSessionWorkspaceActivation("session-1", generation),
    ).resolves.toBeUndefined();

    expect(() =>
      queueSessionWorkspaceActivation({
        sessionId: "session-1",
        path: "/tmp/current",
        branch: null,
        intentGeneration: generation,
      }),
    ).not.toThrow();
  });
});
