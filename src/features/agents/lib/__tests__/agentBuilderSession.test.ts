import { beforeEach, describe, expect, it, vi } from "vitest";

const chatState = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string;
    title?: string;
    archivedAt?: string;
    intent?: "build-agent" | null;
    targetAgentPath?: string | null;
    targetAgentSlug?: string | null;
  }>,
  hasHydratedSessions: true,
  hasMoreSessions: false,
}));

const mocks = vi.hoisted(() => ({
  patchSession: vi.fn(),
  setSkillDrafts: vi.fn(),
  createPersonaSource: vi.fn(),
  deletePersonaSource: vi.fn(),
  promotePersonaSource: vi.fn(),
  listPersonaSources: vi.fn(),
  readAgentSourceFile: vi.fn(),
}));

const createNewTab = vi.fn(async (_title?: string) => {
  const session = { id: "sess-1", title: "New agent" };
  chatState.sessions = [session, ...chatState.sessions];
  return { id: session.id };
});
const closeSession = vi.fn();
const navigateChat = vi.fn();
const deps = { createNewTab, closeSession, navigateChat };

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: {
    getState: () => ({
      sessions: chatState.sessions,
      hasHydratedSessions: chatState.hasHydratedSessions,
      hasMoreSessions: chatState.hasMoreSessions,
      getSession: (id: string) =>
        chatState.sessions.find((session) => session.id === id),
      patchSession: mocks.patchSession,
    }),
  },
}));

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      skillDraftsBySession: {
        "sess-1": [
          { id: "builtin:agent-builder", name: "agent-builder" },
          { id: "skill-1", name: "code-review" },
        ],
      },
      setSkillDrafts: mocks.setSkillDrafts,
    }),
  },
}));

vi.mock("@/shared/api/agents", () => ({
  createPersonaSource: mocks.createPersonaSource,
  deletePersonaSource: mocks.deletePersonaSource,
  promotePersonaSource: mocks.promotePersonaSource,
  listPersonaSources: mocks.listPersonaSources,
  readAgentSourceFile: mocks.readAgentSourceFile,
}));

import {
  discardDraftAgentSession,
  isEmptyDraftAgentSession,
  promoteDraft,
  recoverDraftAgent,
  reconcileAgentBuilderSessions,
  startAgentBuilderSession,
} from "../agentBuilderSession";
import { resetAgentBuilderSourceLifecycleForTests } from "../agentBuilderSourceLifecycle";

const draftSource = {
  type: "agent",
  path: "/Users/x/.agents/agents/draft-sess-1.md",
  name: "Untitled agent sess-1",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true, builderSessionId: "sess-1" },
  writable: true,
};

function patchSessionState(
  id: string,
  patch: Partial<(typeof chatState.sessions)[number]>,
) {
  chatState.sessions = chatState.sessions.map((session) =>
    session.id === id ? { ...session, ...patch } : session,
  );
}

function addBuilderSession(
  patch: Partial<(typeof chatState.sessions)[number]> = {},
) {
  chatState.sessions = [
    {
      id: "sess-1",
      title: "New agent",
      intent: "build-agent",
      targetAgentPath: draftSource.path,
      targetAgentSlug: "draft-sess-1",
      ...patch,
    },
  ];
}

describe("agentBuilderSession", () => {
  beforeEach(() => {
    chatState.sessions = [];
    chatState.hasHydratedSessions = true;
    chatState.hasMoreSessions = false;
    mocks.createPersonaSource.mockReset();
    mocks.deletePersonaSource.mockReset();
    mocks.promotePersonaSource.mockReset();
    mocks.listPersonaSources.mockReset();
    mocks.readAgentSourceFile.mockReset();
    mocks.readAgentSourceFile.mockImplementation(
      async (_path: string, fallback: unknown) => fallback,
    );
    mocks.patchSession.mockReset();
    mocks.patchSession.mockImplementation(patchSessionState);
    mocks.setSkillDrafts.mockReset();
    createNewTab.mockClear();
    closeSession.mockClear();
    navigateChat.mockClear();
    resetAgentBuilderSourceLifecycleForTests();
  });

  it("starts a new draft builder session", async () => {
    mocks.createPersonaSource.mockResolvedValue(draftSource);

    const id = await startAgentBuilderSession({}, deps);

    expect(id).toBe("sess-1");
    expect(mocks.createPersonaSource).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^Untitled agent/),
        properties: expect.objectContaining({
          draft: true,
          builderSessionId: "sess-1",
        }),
      }),
    );
    expect(mocks.patchSession).toHaveBeenCalledWith("sess-1", {
      intent: "build-agent",
      targetAgentPath: draftSource.path,
      targetAgentSlug: "draft-sess-1",
    });
    expect(chatState.sessions[0]).toMatchObject({
      intent: "build-agent",
      targetAgentPath: draftSource.path,
      targetAgentSlug: "draft-sess-1",
    });
    expect(navigateChat).toHaveBeenCalledWith("sess-1");
  });

  it("starts an existing agent builder session by slug", async () => {
    mocks.listPersonaSources.mockResolvedValue([
      {
        ...draftSource,
        path: "/Users/x/.agents/agents/code-reviewer.md",
        name: "Code reviewer",
        properties: {},
      },
    ]);

    const id = await startAgentBuilderSession({ slug: "code-reviewer" }, deps);

    expect(id).toBe("sess-1");
    expect(mocks.createPersonaSource).not.toHaveBeenCalled();
    expect(mocks.patchSession).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        targetAgentPath: "/Users/x/.agents/agents/code-reviewer.md",
        targetAgentSlug: "code-reviewer",
      }),
    );
  });

  it("reuses an existing in-memory builder session by slug", async () => {
    chatState.sessions = [
      {
        id: "sess-old",
        intent: "build-agent",
        targetAgentPath: "/Users/x/.agents/agents/code-reviewer.md",
        targetAgentSlug: "code-reviewer",
      },
    ];

    const id = await startAgentBuilderSession({ slug: "code-reviewer" }, deps);

    expect(id).toBe("sess-old");
    expect(createNewTab).not.toHaveBeenCalled();
    expect(navigateChat).toHaveBeenCalledWith("sess-old");
  });

  it("discardDraftAgentSession deletes the draft and clears builder mode", async () => {
    addBuilderSession();
    mocks.deletePersonaSource.mockResolvedValue(undefined);
    mocks.listPersonaSources.mockResolvedValue([draftSource]);

    await discardDraftAgentSession("sess-1", { closeSession });

    expect(mocks.deletePersonaSource).toHaveBeenCalledWith(draftSource.path);
    expect(chatState.sessions[0]).toMatchObject({
      intent: null,
      targetAgentPath: null,
      targetAgentSlug: null,
    });
    expect(mocks.setSkillDrafts).toHaveBeenCalledWith("sess-1", [
      { id: "skill-1", name: "code-review" },
    ]);
    expect(closeSession).toHaveBeenCalledWith("sess-1");
  });

  it("discardDraftAgentSession follows a draft moved under the same builder session id", async () => {
    addBuilderSession();
    const movedDraft = {
      ...draftSource,
      path: "/Users/x/.agents/agents/constructive-critic.md",
      name: "Constructive Critic",
      content: "Give useful critique.",
    };
    mocks.deletePersonaSource.mockResolvedValue(undefined);
    mocks.listPersonaSources.mockResolvedValue([movedDraft]);

    await discardDraftAgentSession("sess-1");

    expect(mocks.deletePersonaSource).toHaveBeenCalledWith(movedDraft.path);
  });

  it("discardDraftAgentSession deletes the exact draft file when source listing omits it", async () => {
    addBuilderSession();
    const diskDraft = {
      ...draftSource,
      name: "Constructive Critic",
      content: "Give useful critique.",
    };
    mocks.deletePersonaSource.mockResolvedValue(undefined);
    mocks.listPersonaSources.mockResolvedValue([]);
    mocks.readAgentSourceFile.mockResolvedValue(diskDraft);

    await discardDraftAgentSession("sess-1");

    expect(mocks.readAgentSourceFile).toHaveBeenCalledWith(draftSource.path);
    expect(mocks.deletePersonaSource).toHaveBeenCalledWith(draftSource.path);
  });

  it("discardDraftAgentSession clears builder mode even when draft deletion fails", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.deletePersonaSource.mockRejectedValue(new Error("already gone"));

    await discardDraftAgentSession("sess-1", { closeSession });

    expect(chatState.sessions[0]).toMatchObject({
      intent: null,
      targetAgentPath: null,
      targetAgentSlug: null,
    });
    expect(closeSession).toHaveBeenCalledWith("sess-1");
  });

  it("promoteDraft promotes the current draft source and clears builder mode", async () => {
    addBuilderSession();
    const editedDraft = {
      ...draftSource,
      name: "Code reviewer",
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        provider: "openai",
      },
    };
    mocks.listPersonaSources.mockResolvedValue([editedDraft]);
    mocks.promotePersonaSource.mockResolvedValue({
      ...editedDraft,
      path: "/Users/x/.agents/agents/code-reviewer.md",
      properties: { provider: "openai" },
    });

    const promoted = await promoteDraft("sess-1");

    expect(promoted).toMatchObject({
      path: "/Users/x/.agents/agents/code-reviewer.md",
    });
    expect(mocks.promotePersonaSource).toHaveBeenCalledWith(
      draftSource.path,
      expect.objectContaining({
        name: "Code reviewer",
        properties: { provider: "openai" },
      }),
    );
    expect(chatState.sessions[0]).toMatchObject({
      intent: null,
      targetAgentPath: null,
      targetAgentSlug: null,
    });
  });

  it("isEmptyDraftAgentSession checks fresh file contents before returning true", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.readAgentSourceFile.mockResolvedValue({
      ...draftSource,
      name: "Constructive Critic",
      content: "Give useful critique.",
    });

    await expect(isEmptyDraftAgentSession("sess-1")).resolves.toBe(false);
    expect(mocks.readAgentSourceFile).toHaveBeenCalledWith(
      draftSource.path,
      draftSource,
    );
  });

  it("isEmptyDraftAgentSession returns true for an unchanged placeholder draft", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.readAgentSourceFile.mockResolvedValue(draftSource);

    await expect(isEmptyDraftAgentSession("sess-1")).resolves.toBe(true);
  });

  it("isEmptyDraftAgentSession is conservative when the draft file cannot be read", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.readAgentSourceFile.mockRejectedValue(new Error("unavailable"));

    await expect(isEmptyDraftAgentSession("sess-1")).resolves.toBe(false);
  });

  it("recoverDraftAgent rebinds to an existing draft for the session", async () => {
    const movedDraft = {
      ...draftSource,
      path: "/Users/x/.agents/agents/draft-sess-1-2.md",
    };
    mocks.listPersonaSources.mockResolvedValue([movedDraft]);

    await expect(
      recoverDraftAgent("sess-1", draftSource.path),
    ).resolves.toEqual({
      path: movedDraft.path,
      slug: "draft-sess-1-2",
    });
    expect(mocks.createPersonaSource).not.toHaveBeenCalled();
  });

  it("recoverDraftAgent creates a draft when no session draft exists", async () => {
    mocks.listPersonaSources.mockResolvedValue([]);
    mocks.readAgentSourceFile.mockRejectedValue(new Error("missing"));
    mocks.createPersonaSource.mockResolvedValue(draftSource);

    await expect(
      recoverDraftAgent("sess-1", draftSource.path),
    ).resolves.toEqual({
      path: draftSource.path,
      slug: "draft-sess-1",
    });
    expect(mocks.createPersonaSource).toHaveBeenCalled();
  });

  it("startup reconciliation patches loaded sessions from draft frontmatter", async () => {
    chatState.sessions = [{ id: "sess-1" }];
    mocks.listPersonaSources.mockResolvedValue([draftSource]);

    await reconcileAgentBuilderSessions();

    expect(mocks.patchSession).toHaveBeenCalledWith("sess-1", {
      intent: "build-agent",
      targetAgentPath: draftSource.path,
      targetAgentSlug: "draft-sess-1",
    });
  });

  it("startup cleanup deletes only unchanged placeholder drafts for known-dead sessions", async () => {
    const realDraft = {
      ...draftSource,
      path: "/Users/x/.agents/agents/real-draft.md",
      name: "Constructive Critic",
      content: "Push back constructively.",
      properties: { draft: true, builderSessionId: "dead-real" },
    };
    mocks.listPersonaSources.mockResolvedValue([draftSource, realDraft]);
    mocks.readAgentSourceFile.mockResolvedValue(draftSource);

    await reconcileAgentBuilderSessions();

    expect(mocks.deletePersonaSource).toHaveBeenCalledTimes(1);
    expect(mocks.deletePersonaSource).toHaveBeenCalledWith(draftSource.path);
    expect(mocks.deletePersonaSource).not.toHaveBeenCalledWith(realDraft.path);
  });

  it("startup cleanup waits until session hydration proves a session is dead", async () => {
    chatState.hasMoreSessions = true;
    mocks.listPersonaSources.mockResolvedValue([draftSource]);

    await reconcileAgentBuilderSessions();

    expect(mocks.deletePersonaSource).not.toHaveBeenCalled();
  });
});
