import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../stores/chatStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import type {
  ProjectInfo,
  ProjectWorkspace,
} from "@/features/projects/api/projects";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import {
  acceptFirstSend,
  cancelDeferredWorkspaceNaming,
  chooseDeferredWorkspaceSetup,
  createDeferredWorkspaces,
  prepareExistingFirstSend,
  provisionPreSendProjectWorkspaces,
  releaseDeferredWorkspaceSend,
  releaseWorkspaceSendAfterUserEdit,
  workspaceAttachmentsEqualConfiguration,
} from "./firstWorkspaceSend";

vi.mock("@/features/projects/lib/projectChatWorkspaces", async (original) => {
  const actual =
    await original<
      typeof import("@/features/projects/lib/projectChatWorkspaces")
    >();
  return {
    ...actual,
    planProjectChatWorkspaces: vi.fn(),
    rollbackProjectChatWorkspacePlan: vi.fn(),
  };
});
vi.mock("./sessionTargetCoordinator", () => ({
  transitionSessionTarget: vi.fn(),
}));
import {
  planProjectChatWorkspaces,
  rollbackProjectChatWorkspacePlan,
} from "@/features/projects/lib/projectChatWorkspaces";
import { transitionSessionTarget } from "./sessionTargetCoordinator";

const workspace: ProjectWorkspace = {
  id: "app",
  path: "/repo/app",
  kind: "subdirectory",
  source: "selected",
  branch: "main",
  repositoryPath: "/repo",
  worktreePath: "/repo",
  usedByAgent: false,
  startupMode: "worktree",
};
const project = {
  id: "project",
  name: "Project",
  description: "",
  prompt: "",
  icon: "folder",
  color: "blue",
  order: 0,
  archivedAt: null,
  path: "/repo",
  workingDirs: ["/repo/app"],
  useWorktrees: true,
  projectWorkspaces: [workspace],
} as ProjectInfo;
const selected: WorkspaceAttachment = {
  ...workspace,
  id: "path:/repo/app",
  source: "selected",
};

function session(attachments: WorkspaceAttachment[] = []) {
  return {
    id: "s1",
    title: "Chat",
    projectId: project.id,
    executionTarget: { harnessId: "goose" },
    workingDir: "/repo/app",
    workspaceAttachments: attachments,
    createdAt: "now",
    updatedAt: "now",
    messageCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setMultiWorkspaceEnabled(true);
  vi.mocked(rollbackProjectChatWorkspacePlan).mockResolvedValue(undefined);
  useChatStore.setState({ messagesBySession: {}, queuedMessageBySession: {} });
  useChatSessionStore.setState({ sessions: [session()] });
  useProjectStore.setState({ projects: [project] });
});

describe("workspace attachment equality", () => {
  it("requires exact configuration, rejecting missing and extra attachments", () => {
    expect(
      workspaceAttachmentsEqualConfiguration([workspace], [selected]),
    ).toBe(true);
    expect(workspaceAttachmentsEqualConfiguration([workspace], [])).toBe(false);
    expect(
      workspaceAttachmentsEqualConfiguration(
        [workspace],
        [selected, { ...selected, id: "extra", path: "/other" }],
      ),
    ).toBe(false);
  });
});

describe("first workspace send", () => {
  it("provisions a named worktree before any message is queued", async () => {
    const created = {
      ...selected,
      id: "created",
      path: "/repo/worktrees/feature/app",
      source: "created" as const,
      worktreePath: "/repo/worktrees/feature",
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce({
      workingDir: created.path,
      workspaceAttachments: [created],
    });
    vi.mocked(transitionSessionTarget).mockImplementationOnce(async () => {
      expect(useChatSessionStore.getState().getSession("s1")).toMatchObject({
        workingDir: "/repo/app",
        workspaceAttachments: [],
      });
      return {
        status: "committed",
        applied: true,
        target: { harnessId: "goose" },
      };
    });

    await provisionPreSendProjectWorkspaces("s1", project, "feature");

    expect(planProjectChatWorkspaces).toHaveBeenCalledWith(project, "feature");
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
    expect(useChatSessionStore.getState().getSession("s1")).toMatchObject({
      workingDir: created.path,
      workspaceAttachments: [created],
      activeWorkspaceId: created.id,
    });
    expect(transitionSessionTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", workingDir: created.path }),
    );
  });

  it("restores the backend target before rolling back a stale completed setup", async () => {
    const created = {
      ...selected,
      id: "created",
      path: "/repo/worktrees/feature/app",
      source: "created" as const,
      worktreePath: "/repo/worktrees/feature",
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce({
      workingDir: created.path,
      workspaceAttachments: [created],
    });
    let transitionCount = 0;
    vi.mocked(transitionSessionTarget).mockImplementation(async () => {
      transitionCount += 1;
      if (transitionCount === 1) {
        useProjectStore.setState({ projects: [] });
      }
      return {
        status: "committed",
        applied: true,
        target: { harnessId: "goose" },
      };
    });

    await expect(
      provisionPreSendProjectWorkspaces("s1", project, "feature"),
    ).rejects.toThrow("The project workspace changed during setup. Try again.");

    expect(transitionSessionTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "s1", workingDir: "/repo/app" }),
    );
    expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledOnce();
  });

  it("converts an existing transport-ready first send into the choice flow", () => {
    const onNeedsName = vi.fn();
    const onChoice = vi.fn();
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "inherit" },
      text: "from Home",
    });
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (!record) throw new Error("missing queued record");

    expect(
      prepareExistingFirstSend("s1", record.recordId, {
        onNeedsName,
        onChoice,
      }),
    ).toBe(true);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      recordId: record.recordId,
      payload: { text: "from Home" },
      state: { status: "choice", projectId: project.id },
    });
    expect(onNeedsName).not.toHaveBeenCalled();
    expect(onChoice).toHaveBeenCalledOnce();
  });

  it("normalizes mixed context when converting an existing queued first send", () => {
    useChatStore.getState().enqueueTransportReadyMessage("s1", {
      persona: { kind: "persona", id: "reviewer", name: "Reviewer" },
      text: "from Home",
      sendOptions: {
        capturedPersonaSystemPrompt: "Review carefully.",
        executionSystemPrompt: "stale workspace context",
        assistantPrompt: "Use the selected skill.",
      },
    });
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (!record) throw new Error("missing queued record");

    expect(
      prepareExistingFirstSend("s1", record.recordId, {
        onNeedsName: vi.fn(),
        onChoice: vi.fn(),
      }),
    ).toBe(true);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toEqual({
      text: "from Home",
      persona: { kind: "persona", id: "reviewer", name: "Reviewer" },
      sendOptions: {
        capturedPersonaSystemPrompt: "Review carefully.",
        executionSystemPrompt: undefined,
        assistantPrompt: "Use the selected skill.",
      },
    });
  });

  it("queues before the choice and preserves the exact payload", () => {
    const onNeedsName = vi.fn();
    expect(
      acceptFirstSend(
        "s1",
        { persona: { kind: "inherit" }, text: "hello" },
        { onNeedsName },
      ),
    ).toEqual({
      accepted: true,
      deferred: true,
      needsName: false,
    });
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    expect(record).toMatchObject({
      kind: "deferred",
      payload: { text: "hello" },
      state: { status: "choice" },
    });
    expect(onNeedsName).not.toHaveBeenCalled();
  });

  it("keeps immutable intent but drops mixed execution context when deferring", () => {
    expect(
      acceptFirstSend(
        "s1",
        {
          text: "hello",
          persona: { kind: "persona", id: "reviewer", name: "Reviewer" },
          sendOptions: {
            capturedPersonaSystemPrompt: "Review carefully.",
            executionSystemPrompt: "stale workspace context",
            assistantPrompt: "Use the selected skill.",
          },
        },
        { onNeedsName: vi.fn() },
      ),
    ).toMatchObject({ accepted: true, deferred: true });

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload,
    ).toEqual({
      text: "hello",
      persona: { kind: "persona", id: "reviewer", name: "Reviewer" },
      sendOptions: {
        capturedPersonaSystemPrompt: "Review carefully.",
        executionSystemPrompt: undefined,
        assistantPrompt: "Use the selected skill.",
      },
    });
  });

  it("shows the piggyback for auto-create worktrees", () => {
    const onNeedsName = vi.fn();
    useProjectStore.setState({
      projects: [
        {
          ...project,
          projectWorkspaces: [{ ...workspace, startupMode: "auto-worktree" }],
        },
      ],
    });

    expect(
      acceptFirstSend(
        "s1",
        { persona: { kind: "inherit" }, text: "hello" },
        { onNeedsName },
      ),
    ).toEqual({
      accepted: true,
      deferred: true,
      needsName: false,
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      state: { status: "choice" },
    });
    expect(onNeedsName).not.toHaveBeenCalled();
    expect(planProjectChatWorkspaces).not.toHaveBeenCalled();
  });

  it("sends normally when worktrees are manually managed", () => {
    useProjectStore.setState({
      projects: [
        {
          ...project,
          projectWorkspaces: [{ ...workspace, startupMode: "ask-worktree" }],
        },
      ],
    });

    expect(
      acceptFirstSend(
        "s1",
        { persona: { kind: "inherit" }, text: "hello" },
        { queueReady: true },
      ),
    ).toEqual({
      accepted: true,
      deferred: false,
      needsName: false,
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({ kind: "transport-ready", payload: { text: "hello" } });
    expect(planProjectChatWorkspaces).not.toHaveBeenCalled();
  });

  it("keeps the prior naming flow for non-worktree startup modes", () => {
    const onNeedsName = vi.fn();
    useProjectStore.setState({
      projects: [
        {
          ...project,
          projectWorkspaces: [{ ...workspace, startupMode: "branch" }],
        },
      ],
    });

    expect(
      acceptFirstSend(
        "s1",
        { persona: { kind: "inherit" }, text: "hello" },
        { onNeedsName },
      ),
    ).toEqual({
      accepted: true,
      deferred: true,
      needsName: false,
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      state: { status: "naming" },
    });
    expect(onNeedsName).toHaveBeenCalledOnce();
  });

  it("opens naming only after Yes and keeps the queue record authoritative", () => {
    const onNeedsName = vi.fn();
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName },
    );
    const before = useChatStore.getState().queuedMessageBySession.s1?.[0];

    expect(chooseDeferredWorkspaceSetup("s1", true)).toBe(true);

    const after = useChatStore.getState().queuedMessageBySession.s1?.[0];
    expect(after).toMatchObject({
      kind: "deferred",
      recordId: before?.recordId,
      payload: { text: "hello" },
      state: { status: "naming" },
    });
    expect(onNeedsName).not.toHaveBeenCalled();
  });

  it("returns from naming to the choice without replacing the queued record", () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    expect(chooseDeferredWorkspaceSetup("s1", true)).toBe(true);
    const before = useChatStore.getState().queuedMessageBySession.s1;

    expect(cancelDeferredWorkspaceNaming("s1")).toBe(true);

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      recordId: before?.[0]?.recordId,
      payload: { text: "hello" },
      state: { status: "choice" },
    });
  });

  it("uses Skip to prepare the existing checkout and releases the same record", async () => {
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const before = useChatStore.getState().queuedMessageBySession.s1?.[0];

    expect(chooseDeferredWorkspaceSetup("s1", false)).toBe(true);

    await vi.waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession.s1?.[0],
      ).toMatchObject({
        kind: "transport-ready",
        recordId: before?.recordId,
        payload: { text: "hello" },
      });
    });
    expect(planProjectChatWorkspaces).not.toHaveBeenCalled();
  });

  it("requires a name for non-UI callers without accepting", () => {
    expect(
      acceptFirstSend("s1", { persona: { kind: "inherit" }, text: "hello" }),
    ).toEqual({
      accepted: false,
      deferred: false,
      needsName: true,
    });
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("rejects a second send while the deferred first-send slot is occupied", () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "first" },
      { onNeedsName: vi.fn() },
    );

    expect(
      acceptFirstSend("s1", { persona: { kind: "inherit" }, text: "second" }),
    ).toEqual({
      accepted: false,
      deferred: false,
      needsName: false,
      occupied: true,
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0]?.payload.text,
    ).toBe("first");
  });

  it("fails safely when the project workspace configuration changes during naming", async () => {
    const onNeedsName = vi.fn();
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    useProjectStore.setState({
      projects: [{ ...project, projectWorkspaces: [] }],
    });

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(planProjectChatWorkspaces).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      state: {
        status: "failed",
        error:
          "The project workspace configuration changed before setup began.",
      },
    });
  });

  it("ignores workspace ordering and derived metadata changes during setup", async () => {
    useProjectStore.setState({
      projects: [
        {
          ...project,
          projectWorkspaces: [
            { ...workspace, branch: "enriched", usedByAgent: true },
          ],
        },
      ],
    });
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce({
      workingDir: "/repo/app",
      workspaceAttachments: [selected],
    });
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({ kind: "transport-ready", recordId: record.recordId });
  });

  it("restores ACP and rolls back when project policy changes after prepare", async () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    const plan = {
      workingDir: "/created",
      workspaceAttachments: [selected],
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce(plan);
    vi.mocked(transitionSessionTarget).mockImplementationOnce(async () => {
      useProjectStore.setState({ projects: [] });
      return {
        status: "committed",
        applied: true,
        target: { harnessId: "goose" },
      };
    });
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(transitionSessionTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workingDir: "/repo/app" }),
    );
    expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledWith(plan);
    expect(
      (
        useChatStore.getState().queuedMessageBySession.s1?.[0] as {
          state: { status: string };
        }
      ).state.status,
    ).toBe("held");
  });

  it("preserves a concurrent workspace edit while rolling back prepared setup", async () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    const plan = {
      workingDir: "/created",
      workspaceAttachments: [selected],
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce(plan);
    vi.mocked(transitionSessionTarget).mockImplementationOnce(async () => {
      useChatSessionStore.getState().patchSession("s1", {
        workingDir: "/user-choice",
        workspaceAttachments: [
          { ...selected, id: "user-choice", path: "/user-choice" },
        ],
      });
      return {
        status: "committed",
        applied: true,
        target: { harnessId: "goose" },
      };
    });
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(transitionSessionTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workingDir: "/user-choice" }),
    );
    expect(useChatSessionStore.getState().getSession("s1")).toMatchObject({
      workingDir: "/user-choice",
      workspaceAttachments: [expect.objectContaining({ id: "user-choice" })],
    });
    expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledWith(plan);
  });

  it("stops stale planning before config apply without calling it", async () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    vi.mocked(planProjectChatWorkspaces).mockImplementationOnce(async () => {
      useChatSessionStore
        .getState()
        .patchSession("s1", { workingDir: "/user-choice" });
      return { workingDir: "/created", workspaceAttachments: [selected] };
    });

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(transitionSessionTarget).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().getSession("s1")?.workingDir).toBe(
      "/user-choice",
    );
    expect(
      (
        useChatStore.getState().queuedMessageBySession.s1?.[0] as {
          state: { status: string };
        }
      ).state.status,
    ).toBe("held");
  });

  it("times out stalled draft promotion and rolls back workspace setup", async () => {
    vi.useFakeTimers();
    try {
      const plan = {
        workingDir: "/repo/worktrees/feature/app",
        workspaceAttachments: [selected],
      };
      vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce(plan);
      useChatSessionStore.setState({
        sessions: [
          {
            ...session(),
            creationState: "pending",
            clientSessionId: "s1",
          },
        ],
      });

      const provisioning = provisionPreSendProjectWorkspaces(
        "s1",
        project,
        "feature",
      );
      const rejection = expect(provisioning).rejects.toThrow(
        "Chat creation failed during workspace setup.",
      );
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledWith(plan);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for draft promotion before applying ACP configuration", async () => {
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce({
      workingDir: "/repo/app",
      workspaceAttachments: [selected],
    });
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    useChatSessionStore.setState({
      sessions: [
        {
          ...session([
            {
              ...selected,
              source: "inferred",
            },
          ]),
          creationState: "pending",
          clientSessionId: "s1",
        },
      ],
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    const creating = createDeferredWorkspaces("s1", record.recordId, "feature");
    await vi.waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("s1")?.creationState,
      ).toBe("pending");
    });
    expect(
      useChatSessionStore.getState().getSession("s1")?.workspaceAttachments,
    ).toEqual([expect.objectContaining({ source: "inferred" })]);
    expect(transitionSessionTarget).not.toHaveBeenCalled();

    useChatStore.getState().promoteSessionId("s1", "backend-s1");
    useChatSessionStore.getState().promoteDraftSession("s1", "backend-s1");
    await creating;

    expect(transitionSessionTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "backend-s1",
        target: { harnessId: "goose" },
      }),
    );
    expect(
      useChatStore.getState().queuedMessageBySession["backend-s1"]?.[0],
    ).toMatchObject({ kind: "transport-ready" });
  });

  it("rolls back provisioned workspaces and marks the queue failed when draft creation fails", async () => {
    const plan = {
      workingDir: "/created",
      workspaceAttachments: [selected],
      rollback: { createdWorktrees: [], createdBranches: [] },
    };
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce(plan);
    useChatSessionStore.setState({
      sessions: [
        {
          ...session(),
          creationState: "pending",
          clientSessionId: "s1",
        },
      ],
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    const creating = createDeferredWorkspaces("s1", record.recordId, "feature");
    await vi.waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("s1")?.creationState,
      ).toBe("pending");
    });
    useChatSessionStore.getState().patchSession("s1", {
      creationState: "failed",
    });
    await creating;

    expect(rollbackProjectChatWorkspacePlan).toHaveBeenCalledWith(plan);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      recordId: record.recordId,
      state: {
        status: "failed",
        error: "Chat creation failed before workspace setup completed.",
      },
    });
  });

  it("rejects stale naming after draft creation has already failed", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session(),
          creationState: "failed",
          creationError: "Draft creation failed.",
        },
      ],
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(planProjectChatWorkspaces).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      recordId: record.recordId,
      state: { status: "failed", error: "Draft creation failed." },
    });
  });

  it("keeps a creating deferred message paused when setup finishes during editing", async () => {
    let finishApply:
      | ((value: {
          status: "committed";
          applied: true;
          target: { harnessId: "goose" };
        }) => void)
      | undefined;
    vi.mocked(transitionSessionTarget).mockReturnValueOnce(
      new Promise((resolve) => {
        finishApply = resolve;
      }),
    );
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    const creating = createDeferredWorkspaces("s1", record.recordId, null);
    await vi.waitFor(() => expect(transitionSessionTarget).toHaveBeenCalled());
    expect(
      useChatStore
        .getState()
        .setQueuedMessageEditing("s1", record.recordId, true),
    ).toBe(true);
    finishApply?.({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    await creating;

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      recordId: record.recordId,
      payload: { text: "hello" },
      editing: true,
    });

    expect(
      useChatStore.getState().updateQueuedMessage("s1", record.recordId, {
        persona: { kind: "inherit" },
        text: "edited",
      }),
    ).toBe(true);
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      recordId: record.recordId,
      payload: { text: "edited" },
    });
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).not.toHaveProperty("editing");
  });

  it("releases the accepted message after Use as-is succeeds", async () => {
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    await createDeferredWorkspaces("s1", record.recordId, null);

    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      recordId: record.recordId,
    });
  });

  it("holds an unresolved deferred send instead of preparing Goose", async () => {
    useChatSessionStore.setState({
      sessions: [{ ...session(), executionTarget: undefined }],
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    await createDeferredWorkspaces("s1", record.recordId, null);

    expect(transitionSessionTarget).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({
      kind: "deferred",
      recordId: record.recordId,
      state: {
        status: "held",
        error: "Select a model before sending to this unresolved session.",
      },
    });

    useChatSessionStore.getState().replaceSessionExecutionTarget("s1", {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "gpt-5.6",
      modelName: "GPT-5.6",
    });
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });

    await createDeferredWorkspaces("s1", record.recordId, null);

    expect(transitionSessionTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        target: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.6",
          modelName: "GPT-5.6",
        },
      }),
    );
    expect(
      useChatStore.getState().queuedMessageBySession.s1?.[0],
    ).toMatchObject({ kind: "transport-ready", recordId: record.recordId });
  });

  it("continues workspace creation when called with a promoted draft id", async () => {
    vi.mocked(planProjectChatWorkspaces).mockResolvedValueOnce({
      workingDir: "/repo/app",
      workspaceAttachments: [selected],
    });
    vi.mocked(transitionSessionTarget).mockResolvedValueOnce({
      status: "committed",
      applied: true,
      target: { harnessId: "goose" },
    });
    useChatSessionStore.setState({
      sessions: [
        {
          ...session([
            {
              ...selected,
              source: "inferred",
            },
          ]),
          creationState: "pending",
          clientSessionId: "s1",
        },
      ],
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    useChatStore.getState().promoteSessionId("s1", "backend-s1");
    useChatSessionStore.getState().promoteDraftSession("s1", "backend-s1");

    await createDeferredWorkspaces("s1", record.recordId, "feature");

    expect(
      useChatStore.getState().queuedMessageBySession["backend-s1"]?.[0],
    ).toMatchObject({ kind: "transport-ready" });
    expect(transitionSessionTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "backend-s1",
        target: { harnessId: "goose" },
      }),
    );
  });

  it("refuses to release an unresolved deferred send", () => {
    useChatSessionStore.setState({
      sessions: [{ ...session(), executionTarget: undefined }],
    });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");

    expect(releaseDeferredWorkspaceSend("s1", record.recordId, true)).toBe(
      false,
    );
    expect(useChatStore.getState().queuedMessageBySession.s1?.[0]).toBe(record);
  });

  it("releases failure only by Send anyway or an explicit matching user edit", () => {
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "hello" },
      { onNeedsName: vi.fn() },
    );
    const record = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (record?.kind !== "deferred") throw new Error("missing deferred record");
    useChatStore.getState().updateDeferredMessage("s1", record.recordId, {
      ...(record.state as object),
      status: "failed",
    });
    expect(releaseWorkspaceSendAfterUserEdit("s1")).toBe(false);
    useChatSessionStore
      .getState()
      .patchSession("s1", { workspaceAttachments: [selected] });
    expect(releaseWorkspaceSendAfterUserEdit("s1")).toBe(false);
    expect(useChatStore.getState().queuedMessageBySession.s1?.[0]?.kind).toBe(
      "deferred",
    );

    useChatStore.setState({ queuedMessageBySession: {} });
    useChatSessionStore
      .getState()
      .patchSession("s1", { workspaceAttachments: [] });
    acceptFirstSend(
      "s1",
      { persona: { kind: "inherit" }, text: "again" },
      { onNeedsName: vi.fn() },
    );
    const again = useChatStore.getState().queuedMessageBySession.s1?.[0];
    if (again?.kind !== "deferred") throw new Error("missing second record");
    expect(releaseDeferredWorkspaceSend("s1", again.recordId, true)).toBe(true);
  });
});
