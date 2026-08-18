// Regression coverage for `berd_chat` send telemetry on the released
// deferred-workspace leg: a foreground composer send that was deferred for
// workspace setup is dispatched by this background pipeline, so its events
// must anchor to the user-message commit here — while berdctl/background
// payloads (which carry no captured surface) stay untracked by design.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { ensureReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { createUserMessage } from "@/shared/types/messages";

const mocks = vi.hoisted(() => ({
  acpGetSessionInfo: vi.fn(),
  acpLoadSession: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSendMessage: vi.fn(),
  listProjects: vi.fn(),
  resolveSessionCwd: vi.fn(),
  loadWorkspaceInstructionFiles: vi.fn(),
  listSkills: vi.fn(),
  trackChatMessageSent: vi.fn(),
  trackChatSessionStarted: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => mocks.acpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
}));

vi.mock("@/features/projects/api/projects", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/projects/api/projects")
  >()),
  listProjects: (...args: unknown[]) => mocks.listProjects(...args),
}));

vi.mock(
  "@/features/projects/lib/sessionCwdSelection",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/projects/lib/sessionCwdSelection")
    >()),
    resolveSessionCwd: (...args: unknown[]) => mocks.resolveSessionCwd(...args),
  }),
);

vi.mock("@/features/chat/api/workspaceContext", () => ({
  loadWorkspaceInstructionFiles: (...args: unknown[]) =>
    mocks.loadWorkspaceInstructionFiles(...args),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: (...args: unknown[]) => mocks.listSkills(...args),
}));

// Wrappers are mocked so the tests can pin the fire points; CHAT_SOURCE_SURFACE
// and the rest of the module stay real.
vi.mock("@/features/chat/lib/chatTelemetry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/chatTelemetry")
  >()),
  trackChatMessageSent: (...args: unknown[]) =>
    mocks.trackChatMessageSent(...args),
  trackChatSessionStarted: (...args: unknown[]) =>
    mocks.trackChatSessionStarted(...args),
}));

import { CHAT_SOURCE_SURFACE } from "@/features/chat/lib/chatTelemetry";
import { sendQueuedPromptToExistingSessionInBackground } from "./queuedSessionSend";

const SESSION_ID = "deferred-release-session";
const EXECUTION_TARGET = {
  harnessId: "goose",
  modelProviderId: "openai",
  modelId: "gpt-6-berd",
  modelName: "GPT-6 Berd",
} as const;

const PROJECT: ProjectInfo = {
  id: "project-1",
  path: "/tmp/project-source",
  name: "Project One",
  description: "",
  prompt: "",
  icon: "",
  color: "",
  projectWorkspaces: [],
  workingDirs: ["/tmp/project"],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};

function releasedRecord(
  overrides: Partial<QueuedMessageRecord["payload"]> = {},
): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "released-record-1",
    releasedFromDeferred: true,
    payload: {
      text: "held first prompt",
      persona: { kind: "persona", id: "reviewer", name: "Reviewer" },
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "notes.txt",
          path: "/tmp/notes.txt",
        },
      ],
      sendOptions: {
        telemetrySourceSurface: CHAT_SOURCE_SURFACE.GLOBAL_COMPOSER,
      },
      ...overrides,
    },
  };
}

function trackCallCount(): number {
  return (
    mocks.trackChatSessionStarted.mock.calls.length +
    mocks.trackChatMessageSent.mock.calls.length
  );
}

describe("sendQueuedPromptToExistingSessionInBackground telemetry", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isViewingActiveSession: false,
      loadingSessionIds: new Set(),
      scrollTargetMessageBySession: {},
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: SESSION_ID,
          title: "Deferred release",
          executionTarget: EXECUTION_TARGET,
          projectId: PROJECT.id,
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
    useProjectStore.setState({ projects: [], hasFetchedProjects: true });
    useAgentStore.setState({
      personas: [
        {
          id: "reviewer",
          displayName: "Reviewer",
          systemPrompt: "Review carefully.",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    mocks.acpGetSessionInfo.mockResolvedValue(null);
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    // Mirrors the real transport contract sendCore relies on: the user
    // message commits at onPromptDispatching, before the turn settles.
    mocks.acpSendMessage.mockImplementation((...args: unknown[]) => {
      const options = args[2] as
        | { onPromptDispatching?: () => void; onPromptDispatched?: () => void }
        | undefined;
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
      return Promise.resolve(undefined);
    });
    mocks.listProjects.mockResolvedValue([PROJECT]);
    mocks.resolveSessionCwd.mockResolvedValue("/tmp/project");
    mocks.loadWorkspaceInstructionFiles.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([]);
  });

  it("emits Session Started and Message Sent exactly once, at the user-message commit", async () => {
    // Captured inside the transport mock: the commit has not happened yet
    // when the transport is invoked, so nothing may have fired by then.
    let trackCallsBeforeCommit = -1;
    mocks.acpSendMessage.mockImplementationOnce((...args: unknown[]) => {
      trackCallsBeforeCommit = trackCallCount();
      const options = args[2] as
        | { onPromptDispatching?: () => void; onPromptDispatched?: () => void }
        | undefined;
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
      return Promise.resolve(undefined);
    });

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      releasedRecord(),
    );

    expect(trackCallsBeforeCommit).toBe(0);
    expect(mocks.trackChatSessionStarted).toHaveBeenCalledTimes(1);
    expect(mocks.trackChatSessionStarted).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      sourceSurface: CHAT_SOURCE_SURFACE.GLOBAL_COMPOSER,
      hasProject: true,
      hasPersona: true,
      provider: EXECUTION_TARGET.harnessId,
      model: EXECUTION_TARGET.modelId,
    });
    expect(mocks.trackChatMessageSent).toHaveBeenCalledTimes(1);
    expect(mocks.trackChatMessageSent).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      isFirstMessage: true,
      hasAttachments: true,
      hasPersona: true,
      provider: EXECUTION_TARGET.harnessId,
      model: EXECUTION_TARGET.modelId,
    });
  });

  it("emits nothing when the dispatch fails before the user message commits", async () => {
    mocks.acpSendMessage.mockImplementationOnce(() => {
      throw new Error("transport refused before dispatch");
    });

    await expect(
      sendQueuedPromptToExistingSessionInBackground(
        SESSION_ID,
        releasedRecord(),
      ),
    ).rejects.toThrow("transport refused before dispatch");

    expect(mocks.trackChatSessionStarted).not.toHaveBeenCalled();
    expect(mocks.trackChatMessageSent).not.toHaveBeenCalled();
  });

  it("emits Message Sent as not-first and no Session Started when a user message already exists", async () => {
    useChatStore
      .getState()
      .addMessage(SESSION_ID, createUserMessage("earlier message"));

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      releasedRecord(),
    );

    expect(mocks.trackChatSessionStarted).not.toHaveBeenCalled();
    expect(mocks.trackChatMessageSent).toHaveBeenCalledTimes(1);
    expect(mocks.trackChatMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ isFirstMessage: false }),
    );
  });

  // A session with backend history and an empty local transcript replays that
  // history during the background hydration (hydration hard-fails without the
  // replay), so the release commits into the replayed transcript and must not
  // read as a brand-new session.
  it("reports a release that replays the session's history during hydration as not-first", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: SESSION_ID,
          title: "Deferred release",
          executionTarget: EXECUTION_TARGET,
          projectId: PROJECT.id,
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
          messageCount: 12,
        },
      ],
    });
    // The load replays the session's history into the buffer, the way the real
    // notification stream does while `session/load` is in flight.
    mocks.acpLoadSession.mockImplementation(async () => {
      ensureReplayBuffer(SESSION_ID).push(
        createUserMessage("replayed history"),
      );
      return undefined;
    });

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      releasedRecord(),
    );

    expect(mocks.trackChatSessionStarted).not.toHaveBeenCalled();
    expect(mocks.trackChatMessageSent).toHaveBeenCalledTimes(1);
    expect(mocks.trackChatMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ isFirstMessage: false }),
    );
  });

  it("reports an explicit no-persona release as persona-less", async () => {
    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      releasedRecord({ persona: { kind: "none" }, attachments: undefined }),
    );

    expect(mocks.trackChatMessageSent).toHaveBeenCalledTimes(1);
    expect(mocks.trackChatMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ hasPersona: false, hasAttachments: false }),
    );
    expect(mocks.trackChatSessionStarted).toHaveBeenCalledWith(
      expect.objectContaining({ hasPersona: false }),
    );
  });

  // The anchor is observation-only by construction: sendCore runs the commit
  // callback inside the dispatch path, so an uncontained throw would reject a
  // release the backend already accepted and skip the post-commit state
  // transitions.
  it("resolves the release even when the telemetry wrapper throws at the commit", async () => {
    mocks.trackChatMessageSent.mockImplementationOnce(() => {
      throw new Error("telemetry exploded");
    });

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      releasedRecord(),
    );

    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.trackChatMessageSent).toHaveBeenCalledTimes(1);
    // The commit stood: the released user message is in the transcript.
    expect(
      useChatStore
        .getState()
        .messagesBySession[SESSION_ID]?.some(
          (message) => message.role === "user",
        ),
    ).toBe(true);
  });

  it("emits nothing for a released payload without a captured surface (berdctl origin)", async () => {
    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      releasedRecord({
        persona: { kind: "inherit" },
        attachments: undefined,
        // A berdctl-deferred payload carries origin metadata but no captured
        // composer surface — the documented berdctl telemetry exclusion.
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" },
        },
      }),
    );

    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.trackChatSessionStarted).not.toHaveBeenCalled();
    expect(mocks.trackChatMessageSent).not.toHaveBeenCalled();
  });
});
