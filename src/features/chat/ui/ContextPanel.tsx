import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FilesList } from "./FilesList";
import { useGitState } from "@/shared/hooks/useGitState";
import { useChangedFiles } from "@/shared/hooks/useChangedFiles";
import { useHomeDir } from "@/shared/hooks/useHomeDir";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  createBranch,
  createWorktree,
  deleteBranch,
  fetchRepo,
  initRepo,
  listenGitStateChanged,
  pullRepo,
  removeWorktree,
  stashChanges,
  switchBranch,
} from "@/shared/api/git";
import type { CreatedWorktree } from "@/shared/types/git";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { SIDEBAR_NAV_TEXT_CLASS } from "@/shared/ui/sidebar-tokens";
import {
  useChatSessionStore,
  type ActiveWorkspace,
} from "../stores/chatSessionStore";
import { WorkspaceWidget } from "./widgets/WorkspaceWidget";
import { LegacyWorkspaceWidget } from "./widgets/LegacyWorkspaceWidget";
import {
  ChangesEmptyState,
  ChangesErrorState,
  ChangesLoadingState,
  ChangesWidget,
  WorkspaceChangesWidget,
} from "./widgets/ChangesWidget";
import { ArtifactsWidget } from "./widgets/ArtifactsWidget";
import { formatErrorMessage } from "./widgets/formatError";
import {
  WorkspaceAddDialog,
  type WorkspaceAddCandidate,
} from "./widgets/WorkspaceAddDialog";
import {
  type WorkspaceGitRuntime,
  useWorkspaceChangedFilesRuntimes,
  useWorkspaceGitRuntimes,
} from "./hooks/useWorkspaceGitRuntimes";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import {
  classifyWorkspaceAttachment,
  getWorkspaceAttachments,
  getWorkspaceCleanupTarget,
  getRelativeWorkspacePath,
  getWorkspaceDisplayName,
  isSameWorkspacePath,
  workspaceAttachmentIdForPath,
  workspaceAttachmentUsesCleanupTarget,
} from "@/features/chat/lib/workspaceAttachments";
import {
  hasDeferredWorkspaceSend,
  releaseWorkspaceSendAfterUserEdit,
} from "@/features/chat/lib/firstWorkspaceSend";
import { isRemoteSession } from "@/features/chat/lib/remoteSession";
import { RemoteWorkspaceSummary } from "./widgets/RemoteWorkspaceSummary";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import { useChangeSessionFolder } from "@/features/chat/hooks/useChangeSessionFolder";
import { supersedePendingSessionWorkspaceActivation } from "@/features/chat/lib/sessionWorkspaceActivation";
import { useChatStore } from "../stores/chatStore";
import { SessionPullRequestsWidget } from "./widgets/PullRequestsWidget";
import { RELATED_PULL_REQUESTS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import type { CreatedWorkspaceWorktreeContext } from "./widgets/WorkspaceCreateDialog";
import type { WorkspaceRemovalPlan } from "./widgets/WorkspaceRowActionsMenu";

interface ContextPanelProps {
  sessionId: string;
  projectId?: string;
  projectName?: string;
  projectIcon?: string;
  projectColor?: string;
  projectWorkingDirs?: string[];
  sessionWorkingDir?: string | null;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onOpenTerminalAtPath?: (path: string) => void;
}

interface ContextPanelWorktreeTrackerProps {
  sessionId: string;
  projectWorkingDirs?: string[];
  sessionWorkingDir?: string | null;
}

interface PendingCreatedWorktree {
  path: string;
  branch: string | null;
}

type ContextPanelTab = "details" | "changes" | "files";
type ContextPanelSection =
  | "workspace"
  | "pullRequests"
  | "changes"
  | "artifacts";
const TAB_CONTENT_CLASS =
  "scrollbar-none w-full min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4";
type ContextPanelSectionVisibility = Record<ContextPanelSection, boolean>;

const SECTION_VISIBILITY_STORAGE_KEY = "goose:context-panel:section-visibility";
const DEFAULT_SECTION_VISIBILITY: ContextPanelSectionVisibility = {
  workspace: true,
  pullRequests: true,
  changes: true,
  artifacts: true,
};

function validateSectionVisibility(
  value: unknown,
  defaults: ContextPanelSectionVisibility,
): ContextPanelSectionVisibility {
  if (!value || typeof value !== "object") return defaults;
  const parsed = value as Partial<Record<ContextPanelSection, unknown>>;
  return {
    workspace:
      typeof parsed.workspace === "boolean"
        ? parsed.workspace
        : defaults.workspace,
    pullRequests:
      typeof parsed.pullRequests === "boolean"
        ? parsed.pullRequests
        : defaults.pullRequests,
    changes:
      typeof parsed.changes === "boolean" ? parsed.changes : defaults.changes,
    artifacts:
      typeof parsed.artifacts === "boolean"
        ? parsed.artifacts
        : defaults.artifacts,
  };
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(paths.filter((path): path is string => Boolean(path))),
  );
}

function normalizeComparablePath(path: string | null | undefined) {
  if (!path) return null;
  let normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith("/private/var/")) {
    normalized = normalized.replace(/^\/private\/var\//, "/var/");
  }
  return normalized;
}

export function ContextPanelWorktreeTracker({
  sessionId,
  projectWorkingDirs = [],
  sessionWorkingDir,
}: ContextPanelWorktreeTrackerProps) {
  const projectDefaultWorkspaceRoot = projectWorkingDirs[0] ?? null;
  const activeContext = useChatSessionStore(
    (s) => s.activeWorkspaceBySession[sessionId],
  );
  const runtime = useChatStore((state) => state.sessionStateById[sessionId]);
  const setActiveWorkspace = useChatSessionStore((s) => s.setActiveWorkspace);
  // Remote sessions keep their worktrees on the SSH host; the local git probe
  // and worktree-adoption events below would act on the wrong filesystem.
  const sessionIsRemote = useChatSessionStore((s) =>
    isRemoteSession(s.sessions.find((candidate) => candidate.id === sessionId)),
  );
  const gitTargetPath =
    activeContext?.path ??
    sessionWorkingDir ??
    projectDefaultWorkspaceRoot ??
    null;
  const { data: gitState } = useGitState(
    gitTargetPath,
    Boolean(gitTargetPath) && !sessionIsRemote,
  );
  const previousWorktreeKeyRef = useRef<string | null>(null);
  const pendingCreatedWorktreeRef = useRef<PendingCreatedWorktree | null>(null);
  const chatRuntime = runtime ?? INITIAL_SESSION_CHAT_RUNTIME;
  const isWorking =
    isSessionRunning(chatRuntime.chatState) ||
    chatRuntime.activeRunId !== null ||
    chatRuntime.streamingMessageId !== null ||
    chatRuntime.isRunCancellationPending;
  const eventSourcePaths = uniquePaths([
    gitTargetPath,
    activeContext?.path,
    sessionWorkingDir,
    ...projectWorkingDirs,
  ]);
  const normalizedEventSourcePaths = eventSourcePaths
    .map((path) => normalizeComparablePath(path))
    .filter((path): path is string => Boolean(path));
  const eventSourcePathKey = normalizedEventSourcePaths.join("\0");

  useEffect(() => {
    if (sessionIsRemote || !isWorking) return;
    const eventSourcePathSet = new Set(
      eventSourcePathKey ? eventSourcePathKey.split("\0") : [],
    );

    const unlisten = listenGitStateChanged((payload) => {
      if (payload.operation !== "create_worktree") return;

      const createdPath = payload.affectedPaths.at(-1);
      if (!createdPath) return;

      const sourcePath = normalizeComparablePath(payload.path);
      if (!sourcePath || !eventSourcePathSet.has(sourcePath)) return;

      pendingCreatedWorktreeRef.current = {
        path: createdPath,
        branch: payload.branch,
      };
    });

    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [eventSourcePathKey, isWorking, sessionIsRemote]);

  useEffect(() => {
    const trackingKey = `${sessionId}:${normalizeComparablePath(
      gitTargetPath,
    )}`;
    if (previousWorktreeKeyRef.current !== trackingKey) {
      previousWorktreeKeyRef.current = trackingKey;
      pendingCreatedWorktreeRef.current = null;
    }

    if (!gitState?.isGitRepo) {
      pendingCreatedWorktreeRef.current = null;
      return;
    }

    const pendingCreatedWorktree = pendingCreatedWorktreeRef.current;
    if (pendingCreatedWorktree && !isWorking) {
      const pendingPath = normalizeComparablePath(pendingCreatedWorktree.path);
      const createdWorktree = gitState.worktrees.find((worktree) => {
        const path = normalizeComparablePath(worktree.path);
        return path && path === pendingPath;
      });

      if (createdWorktree) {
        const activePath = normalizeComparablePath(activeContext?.path);
        if (pendingPath && pendingPath !== activePath) {
          setActiveWorkspace(sessionId, {
            path: createdWorktree.path,
            branch: createdWorktree.branch ?? pendingCreatedWorktree.branch,
          });
        }
        pendingCreatedWorktreeRef.current = null;
      }
      return;
    }
  }, [
    activeContext?.path,
    gitState,
    gitTargetPath,
    isWorking,
    sessionId,
    setActiveWorkspace,
  ]);

  return null;
}

export function ContextPanel({
  sessionId,
  projectId: _projectId,
  projectName,
  projectIcon: _projectIcon,
  projectColor: _projectColor,
  projectWorkingDirs = [],
  sessionWorkingDir,
  terminalOpen = false,
  onToggleTerminal,
  onOpenTerminalAtPath,
}: ContextPanelProps) {
  const { t } = useTranslation("chat");
  const relatedPullRequestsExperiment = useExperiment(
    RELATED_PULL_REQUESTS_EXPERIMENT_ID,
  );
  const relatedPullRequestsEnabled = Boolean(
    relatedPullRequestsExperiment?.enabled,
  );
  const workspaceRepository = useWorkspaceRepository();
  const [activeTab, setActiveTab] = useState<ContextPanelTab>("details");
  const [isAddWorkspaceOpen, setIsAddWorkspaceOpen] = useState(false);
  const [sectionVisibility, setSectionVisibility] = usePersistedState(
    SECTION_VISIBILITY_STORAGE_KEY,
    DEFAULT_SECTION_VISIBILITY,
    validateSectionVisibility,
  );
  const activeContext = useChatSessionStore(
    (s) => s.activeWorkspaceBySession[sessionId],
  );
  const setActiveWorkspace = useChatSessionStore((s) => s.setActiveWorkspace);
  const patchSession = useChatSessionStore((s) => s.patchSession);
  const session = useChatSessionStore((s) =>
    s.sessions.find((candidate) => candidate.id === sessionId),
  );
  // Everything below the remote guard talks to local-filesystem Tauri
  // commands (git probes, changed files, folder pickers, file browsing). A
  // remote session's paths live on its SSH host, so those queries stay off
  // and the tabs degrade to compact remote summaries instead.
  const remoteHost = isRemoteSession(session)
    ? (session?.remoteHost?.trim() ?? null)
    : null;
  const allSessions = useChatSessionStore((s) => s.sessions);
  const homeDir = useHomeDir();
  const attachWorkspace = useChatSessionStore((s) => s.attachWorkspace);
  const removeWorkspaceAttachment = useChatSessionStore(
    (s) => s.removeWorkspaceAttachment,
  );
  const releaseHeldSend = useCallback(
    () => releaseWorkspaceSendAfterUserEdit(sessionId),
    [sessionId],
  );

  const workspaceSet = workspaceRepository.chatWorkspaces(session, {
    activePath: activeContext?.path,
  });
  const isMultiWorkspaceMode = workspaceRepository.mode === "multi";
  const workspaceAttachments = workspaceSet.workspaces;
  const projectDefaultWorkspaceRoot = projectWorkingDirs[0] ?? null;
  const gitTargetPath = isMultiWorkspaceMode
    ? (activeContext?.path ??
      workspaceSet.primary?.path ??
      projectDefaultWorkspaceRoot ??
      (!projectName ? sessionWorkingDir : null) ??
      null)
    : (activeContext?.path ??
      sessionWorkingDir ??
      projectDefaultWorkspaceRoot ??
      workspaceSet.primary?.path ??
      null);
  const fileBrowserRoots = uniquePaths(
    isMultiWorkspaceMode && workspaceAttachments.length > 0
      ? workspaceAttachments.map((workspace) => workspace.path)
      : [gitTargetPath],
  );
  const hasWorkspaceAttachments =
    isMultiWorkspaceMode && workspaceAttachments.length > 0;
  const queryClient = useQueryClient();
  const isWorkspaceContextTab =
    activeTab === "details" || activeTab === "changes";
  const {
    data: fallbackGitState,
    error: fallbackGitError,
    isLoading: fallbackGitIsLoading,
    isFetching: fallbackGitIsFetching,
  } = useGitState(
    gitTargetPath,
    isWorkspaceContextTab && !hasWorkspaceAttachments && remoteHost === null,
  );
  const workspaceGitRuntimes = useWorkspaceGitRuntimes(
    workspaceAttachments,
    remoteHost === null &&
      isMultiWorkspaceMode &&
      (isWorkspaceContextTab || isAddWorkspaceOpen),
  );
  const workspaceChangedFileRuntimes = useWorkspaceChangedFilesRuntimes(
    workspaceGitRuntimes,
    isWorkspaceContextTab && remoteHost === null,
  );
  const renderedWorkspaceAttachments = useMemo(
    () => workspaceGitRuntimes.map((runtime) => runtime.workspace),
    [workspaceGitRuntimes],
  );
  const workspaceGitStateById = useMemo(
    () =>
      Object.fromEntries(
        workspaceGitRuntimes.map((runtime) => [
          runtime.workspace.id,
          runtime.gitState,
        ]),
      ),
    [workspaceGitRuntimes],
  );

  const {
    data: fallbackChangedFiles,
    error: fallbackChangedFilesError,
    isLoadingError: isFallbackChangedFilesLoadingError,
    isLoading: isFallbackFilesLoading,
  } = useChangedFiles(
    gitTargetPath,
    isWorkspaceContextTab && !hasWorkspaceAttachments && remoteHost === null,
  );
  const shouldShowChanges = hasWorkspaceAttachments
    ? workspaceChangedFileRuntimes.length > 0
    : Boolean(gitTargetPath) && fallbackGitState?.isGitRepo !== false;
  // The git probe decides whether the tab can render changes at all, so wait
  // for it before committing to an empty state — otherwise a repo-backed
  // session flashes "not a git repo" on every first open of the tab.
  const isChangesProbeLoading = hasWorkspaceAttachments
    ? workspaceGitRuntimes.some(
        (runtime) => runtime.isLoading && !runtime.gitState,
      )
    : Boolean(gitTargetPath) && fallbackGitIsLoading && !fallbackGitState;
  // A failed probe also leaves the tab with nothing to render, but it is not
  // evidence that the folder lacks a repo — surface the failure instead, or we
  // would tell someone with a healthy repo to go initialize git.
  const changesProbeError = hasWorkspaceAttachments
    ? (workspaceGitRuntimes.find((runtime) => runtime.error)?.error ?? null)
    : fallbackGitError instanceof Error
      ? fallbackGitError
      : null;
  // Explain which precondition is missing instead of rendering a blank rail.
  // Phrasing follows how many folders the chat actually carries, not whether
  // multi-workspace mode is on: singular "this folder" would misdescribe a
  // chat holding several non-git workspaces.
  const changesFolderCount = hasWorkspaceAttachments
    ? workspaceAttachments.length
    : Number(Boolean(gitTargetPath));
  const changesUnavailableMessage =
    changesFolderCount === 0
      ? t("contextPanel.empty.folderNotSet")
      : changesFolderCount > 1
        ? t("contextPanel.empty.noGitWorkspaces")
        : t("contextPanel.empty.notGitRepo");
  const shouldShowArtifacts =
    hasWorkspaceAttachments && workspaceGitRuntimes.length > 0
      ? workspaceGitRuntimes.every(
          (runtime) => runtime.gitState?.isGitRepo === false,
        )
      : Boolean(gitTargetPath) && fallbackGitState?.isGitRepo === false;

  // Git mutations can move branches in any worktree of the repo, so invalidate
  // every cached path, not just the one this panel is showing.
  const refetchAll = useCallback(async () => {
    await Promise.all([
      queryClient
        .invalidateQueries({ queryKey: ["git-state"] })
        .catch(() => undefined),
      queryClient
        .invalidateQueries({ queryKey: ["changed-files"] })
        .catch(() => undefined),
    ]);
  }, [queryClient]);

  const handleContextChange = useCallback(
    (context: ActiveWorkspace) => {
      setActiveWorkspace(sessionId, context);
    },
    [sessionId, setActiveWorkspace],
  );

  const handleSwitchBranch = useCallback(
    async (path: string, branch: string) => {
      try {
        await switchBranch(path, branch);
      } finally {
        await refetchAll();
      }
    },
    [refetchAll],
  );

  const handleStashAndSwitch = useCallback(
    async (path: string, branch: string) => {
      try {
        await stashChanges(path);
        try {
          await switchBranch(path, branch);
        } catch (error) {
          throw new Error(
            `${formatErrorMessage(
              error,
              t("contextPanel.picker.switchError", { branch }),
            )} ${t("contextPanel.picker.changesStashed")}`,
          );
        }
      } finally {
        await refetchAll();
      }
    },
    [refetchAll, t],
  );

  const handleWorkspaceWorktreeSelected = useCallback(
    async (
      runtime: WorkspaceGitRuntime,
      worktreePath: string,
      branch: string | null,
    ) => {
      // Compare via the expanded spelling: `gitContext.worktreePath` is
      // absolute, so a `~`-spelled workspace's subdirectory suffix would be
      // lost against the raw `workspace.path`.
      const relativePath = getRelativeWorkspacePath(
        runtime.comparableWorkspace.path,
        runtime.gitContext.worktreePath,
      );
      const nextPath =
        relativePath && relativePath.length > 0
          ? `${worktreePath.replace(/\/+$/, "")}/${relativePath}`
          : worktreePath;
      const classification = runtime.gitState
        ? classifyWorkspaceAttachment(nextPath, runtime.gitState)
        : null;
      const session = useChatSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return;
      const nextWorkspaceId = workspaceAttachmentIdForPath(nextPath);
      const replacesActiveWorkspace =
        session.activeWorkspaceId === runtime.workspace.id ||
        isSameWorkspacePath(activeContext?.path, runtime.workspace.path);
      if (replacesActiveWorkspace) {
        await supersedePendingSessionWorkspaceActivation(sessionId);
      }
      patchSession(sessionId, {
        ...(replacesActiveWorkspace ? { workingDir: nextPath } : {}),
        workspaceAttachments: getWorkspaceAttachments(session).map(
          (attachment) =>
            attachment.id === runtime.workspace.id
              ? {
                  ...attachment,
                  id: nextWorkspaceId,
                  path: nextPath,
                  branch,
                  kind: classification?.kind ?? attachment.kind,
                  repositoryPath:
                    classification?.repositoryPath ?? attachment.repositoryPath,
                  worktreePath: classification?.worktreePath ?? worktreePath,
                }
              : attachment,
        ),
        activeWorkspaceId:
          session.activeWorkspaceId === runtime.workspace.id
            ? nextWorkspaceId
            : session.activeWorkspaceId,
      });
      if (isSameWorkspacePath(activeContext?.path, runtime.workspace.path)) {
        setActiveWorkspace(sessionId, { path: nextPath, branch });
      }
      releaseHeldSend();
      void refetchAll();
    },
    [
      activeContext?.path,
      patchSession,
      refetchAll,
      releaseHeldSend,
      sessionId,
      setActiveWorkspace,
    ],
  );

  const handleWorkspaceSwitchBranch = useCallback(
    async (runtime: WorkspaceGitRuntime, path: string, branch: string) => {
      await handleSwitchBranch(path, branch);
      attachWorkspace(sessionId, {
        path: runtime.workspace.path,
        branch,
        kind: runtime.workspace.kind,
        repositoryPath: runtime.workspace.repositoryPath,
        worktreePath: runtime.workspace.worktreePath,
        source: runtime.workspace.source,
      });
      releaseHeldSend();
    },
    [attachWorkspace, handleSwitchBranch, releaseHeldSend, sessionId],
  );

  const handleWorkspaceStashAndSwitch = useCallback(
    async (runtime: WorkspaceGitRuntime, path: string, branch: string) => {
      await handleStashAndSwitch(path, branch);
      attachWorkspace(sessionId, {
        path: runtime.workspace.path,
        branch,
        kind: runtime.workspace.kind,
        repositoryPath: runtime.workspace.repositoryPath,
        worktreePath: runtime.workspace.worktreePath,
        source: runtime.workspace.source,
      });
      releaseHeldSend();
    },
    [attachWorkspace, handleStashAndSwitch, releaseHeldSend, sessionId],
  );

  const handleInitRepo = useCallback(
    async (path: string) => {
      await initRepo(path);
      await refetchAll();
    },
    [refetchAll],
  );

  const { changeFolder: handleChangeFolder, isChangingFolder } =
    useChangeSessionFolder(sessionId, {
      defaultPath: gitTargetPath,
      attachWorkspace: isMultiWorkspaceMode && Boolean(projectName),
    });

  const handleIncludeWorkspaceCandidate = useCallback(
    (candidate: WorkspaceAddCandidate) => {
      attachWorkspace(sessionId, {
        path: candidate.path,
        branch: candidate.classification.branch,
        kind: candidate.classification.kind,
        repositoryPath: candidate.classification.repositoryPath,
        worktreePath: candidate.classification.worktreePath,
        source: "selected",
      });
      releaseHeldSend();
      void refetchAll();
      toast.success(
        t("contextPanel.includedWorkspaces.includeSuccess", {
          name: getWorkspaceDisplayName(candidate.path),
        }),
      );
    },
    [attachWorkspace, refetchAll, releaseHeldSend, sessionId, t],
  );

  const getWorkspaceRemovalPlan = useCallback(
    (workspace: WorkspaceAttachment): WorkspaceRemovalPlan => {
      const target = getWorkspaceCleanupTarget(workspace);
      if (!target) {
        return {
          cleanup: "none",
          isLastUse: false,
          usedByAnotherWorkspaceInChat: false,
          usedByAnotherChat: false,
          branch: null,
          baseBranch: null,
          repositoryPath: null,
          worktreePath: null,
          createdBranch: false,
        };
      }

      // Compare in the home-expanded spelling: cleanup targets store absolute
      // paths while a sibling attachment can still carry its raw `~` path, and
      // a missed match here deletes a branch that sibling still uses.
      const usedByAnotherWorkspaceInChat = Boolean(
        session &&
          getWorkspaceAttachments(session).some(
            (attachment) =>
              attachment.id !== workspace.id &&
              attachment.source !== "excluded" &&
              workspaceAttachmentUsesCleanupTarget(attachment, target, homeDir),
          ),
      );
      const usedByAnotherChat = allSessions.some(
        (candidate) =>
          candidate.id !== sessionId &&
          !candidate.archivedAt &&
          getWorkspaceAttachments(candidate).some(
            (attachment) =>
              attachment.source !== "excluded" &&
              workspaceAttachmentUsesCleanupTarget(attachment, target, homeDir),
          ),
      );

      return {
        cleanup: target.cleanup,
        isLastUse: !usedByAnotherWorkspaceInChat && !usedByAnotherChat,
        usedByAnotherWorkspaceInChat,
        usedByAnotherChat,
        branch: target.branch,
        baseBranch: target.baseBranch,
        repositoryPath: target.repositoryPath,
        worktreePath: target.worktreePath,
        createdBranch: target.createdBranch,
      };
    },
    [allSessions, homeDir, session, sessionId],
  );

  const cleanupWorkspace = useCallback(
    async (workspace: WorkspaceAttachment, plan: WorkspaceRemovalPlan) => {
      if (plan.cleanup === "none" || !plan.isLastUse) {
        return;
      }

      const repositoryPath =
        plan.repositoryPath ??
        workspace.repositoryPath ??
        workspace.worktreePath ??
        workspace.path;

      if (plan.cleanup === "worktree") {
        const worktreePath =
          plan.worktreePath ?? workspace.worktreePath ?? workspace.path;
        await removeWorktree(repositoryPath, worktreePath, true);
        if (plan.createdBranch && plan.branch) {
          await deleteBranch(
            repositoryPath,
            plan.branch,
            true,
            plan.baseBranch ?? undefined,
          );
        }
        return;
      }

      if (plan.branch) {
        const checkoutPath =
          plan.worktreePath ??
          workspace.worktreePath ??
          plan.repositoryPath ??
          workspace.path;
        await deleteBranch(
          checkoutPath,
          plan.branch,
          true,
          plan.baseBranch ?? undefined,
        );
      }
    },
    [],
  );

  const handleRemoveWorkspace = useCallback(
    async (
      workspace: WorkspaceAttachment,
      removalPlan: WorkspaceRemovalPlan,
    ) => {
      await cleanupWorkspace(workspace, removalPlan);
      removeWorkspaceAttachment(sessionId, workspace.id);
      releaseHeldSend();
      await refetchAll();
    },
    [
      cleanupWorkspace,
      refetchAll,
      releaseHeldSend,
      removeWorkspaceAttachment,
      sessionId,
    ],
  );

  const handleFetch = useCallback(
    async (path: string) => {
      await fetchRepo(path);
      await refetchAll();
    },
    [refetchAll],
  );

  const handlePull = useCallback(
    async (path: string) => {
      await pullRepo(path);
      await refetchAll();
    },
    [refetchAll],
  );

  const handleCreateBranch = useCallback(
    async (
      runtime: WorkspaceGitRuntime,
      path: string,
      name: string,
      baseBranch: string,
    ) => {
      await createBranch(path, name, baseBranch);
      const updatedGitState = runtime.gitState
        ? {
            ...runtime.gitState,
            currentBranch: name,
            worktrees: runtime.gitState.worktrees.map((worktree) =>
              isSameWorkspacePath(
                worktree.path,
                runtime.gitContext.worktreePath ?? path,
              )
                ? { ...worktree, branch: name }
                : worktree,
            ),
          }
        : null;
      // Classify via the expanded spelling (same rule as the worktree
      // handlers below): a raw `~` workspace path never matches gitState's
      // absolute worktrees, so classification would fall through and persist
      // a `~` worktreePath into the managed-branch lifecycle, which cleanup
      // later feeds to `git_delete_branch` un-expanded.
      const classification = updatedGitState
        ? classifyWorkspaceAttachment(
            runtime.comparableWorkspace.path,
            updatedGitState,
          )
        : null;
      attachWorkspace(sessionId, {
        path: runtime.workspace.path,
        branch: name,
        kind: classification?.kind ?? runtime.workspace.kind,
        repositoryPath:
          classification?.repositoryPath ?? runtime.workspace.repositoryPath,
        worktreePath:
          classification?.worktreePath ?? runtime.workspace.worktreePath,
        source: "created",
        lifecycle: {
          owner: "goose",
          cleanup: "branch",
          branch: name,
          baseBranch,
          repositoryPath:
            classification?.repositoryPath ??
            runtime.workspace.repositoryPath ??
            null,
          worktreePath:
            classification?.worktreePath ??
            runtime.workspace.worktreePath ??
            null,
          createdBranch: true,
        },
      });
      releaseHeldSend();
      await refetchAll();
    },
    [attachWorkspace, refetchAll, releaseHeldSend, sessionId],
  );

  const handleLegacyCreateBranch = useCallback(
    async (path: string, name: string, baseBranch: string) => {
      await createBranch(path, name, baseBranch);
      await refetchAll();
    },
    [refetchAll],
  );

  const handleCreateWorktree = useCallback(
    async (
      path: string,
      name: string,
      branch: string,
      createBranchForWorktree: boolean,
      baseBranch?: string,
    ): Promise<CreatedWorktree> => {
      const createdWorktree = await createWorktree(
        path,
        name,
        branch,
        createBranchForWorktree,
        baseBranch,
      );
      await refetchAll();
      return createdWorktree;
    },
    [refetchAll],
  );

  const handleWorkspaceWorktreeCreated = useCallback(
    async (
      runtime: WorkspaceGitRuntime,
      worktree: CreatedWorktree,
      context: CreatedWorkspaceWorktreeContext,
    ) => {
      if (!runtime.gitState) return;
      const { workspace, gitState, gitContext, comparableWorkspace } = runtime;
      // Same expanded-spelling rule as the worktree-select handler above:
      // mixing the raw `~` workspace path with the absolute
      // `gitContext.worktreePath` would drop a subdirectory suffix.
      const sourceWorktreePath =
        gitContext.worktreePath ??
        comparableWorkspace.worktreePath ??
        comparableWorkspace.repositoryPath ??
        comparableWorkspace.path;
      const relativePath = getRelativeWorkspacePath(
        comparableWorkspace.path,
        sourceWorktreePath,
      );
      const includedPath =
        relativePath && relativePath.length > 0
          ? `${worktree.path.replace(/\/+$/, "")}/${relativePath}`
          : worktree.path;
      const classification = classifyWorkspaceAttachment(includedPath, {
        ...gitState,
        isWorktree: true,
        currentBranch: worktree.branch,
        worktrees: [
          ...gitState.worktrees.filter(
            (existingWorktree) => existingWorktree.path !== worktree.path,
          ),
          {
            path: worktree.path,
            branch: worktree.branch,
            isMain: false,
          },
        ],
      });
      const session = useChatSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return;
      const nextWorkspaceId = workspaceAttachmentIdForPath(includedPath);
      await supersedePendingSessionWorkspaceActivation(sessionId);
      patchSession(sessionId, {
        workingDir: includedPath,
        workspaceAttachments: getWorkspaceAttachments(session).map(
          (attachment) =>
            attachment.id === workspace.id
              ? {
                  ...attachment,
                  id: nextWorkspaceId,
                  path: includedPath,
                  branch: classification.branch,
                  kind: classification.kind,
                  repositoryPath:
                    classification.repositoryPath ?? workspace.repositoryPath,
                  worktreePath: classification.worktreePath ?? worktree.path,
                  source: "created",
                  lifecycle: {
                    owner: "goose",
                    cleanup: "worktree",
                    branch: worktree.branch,
                    baseBranch: context.baseBranch,
                    repositoryPath:
                      classification.repositoryPath ??
                      workspace.repositoryPath ??
                      gitState.mainWorktreePath ??
                      null,
                    worktreePath: worktree.path,
                    createdBranch: context.createdBranch,
                  },
                }
              : attachment,
        ),
        activeWorkspaceId: nextWorkspaceId,
      });
      setActiveWorkspace(sessionId, {
        path: includedPath,
        branch: classification.branch,
      });
      releaseHeldSend();
      void refetchAll();
      toast.success(
        t("contextPanel.includedWorkspaces.includeSuccess", {
          name: getWorkspaceDisplayName(includedPath),
        }),
      );
    },
    [
      patchSession,
      refetchAll,
      releaseHeldSend,
      sessionId,
      setActiveWorkspace,
      t,
    ],
  );

  const handleIncludeCreatedWorktree = useCallback(
    (
      candidate: WorkspaceAddCandidate,
      worktree: CreatedWorktree,
      context: CreatedWorkspaceWorktreeContext,
    ) => {
      const relativePath = getRelativeWorkspacePath(
        candidate.path,
        candidate.classification.worktreePath,
      );
      const includedPath =
        relativePath && relativePath.length > 0
          ? `${worktree.path.replace(/\/+$/, "")}/${relativePath}`
          : worktree.path;
      const classification = classifyWorkspaceAttachment(includedPath, {
        ...candidate.gitState,
        isWorktree: true,
        currentBranch: worktree.branch,
        worktrees: [
          ...candidate.gitState.worktrees.filter(
            (existingWorktree) => existingWorktree.path !== worktree.path,
          ),
          {
            path: worktree.path,
            branch: worktree.branch,
            isMain: false,
          },
        ],
      });
      const repairsHeldSend = hasDeferredWorkspaceSend(sessionId);
      attachWorkspace(sessionId, {
        path: includedPath,
        branch: classification.branch,
        kind: classification.kind,
        repositoryPath:
          classification.repositoryPath ??
          candidate.classification.repositoryPath,
        worktreePath: classification.worktreePath ?? worktree.path,
        source: "created",
        lifecycle: {
          owner: "goose",
          cleanup: "worktree",
          branch: worktree.branch,
          baseBranch: context.baseBranch,
          repositoryPath:
            classification.repositoryPath ??
            candidate.classification.repositoryPath ??
            candidate.gitState.mainWorktreePath ??
            null,
          worktreePath: worktree.path,
          createdBranch: context.createdBranch,
        },
      });
      if (repairsHeldSend) {
        patchSession(sessionId, { workingDir: includedPath });
        setActiveWorkspace(sessionId, {
          path: includedPath,
          branch: classification.branch,
        });
      }
      releaseHeldSend();
      void refetchAll();
      toast.success(
        t("contextPanel.includedWorkspaces.includeSuccess", {
          name: getWorkspaceDisplayName(includedPath),
        }),
      );
    },
    [
      attachWorkspace,
      patchSession,
      refetchAll,
      releaseHeldSend,
      sessionId,
      setActiveWorkspace,
      t,
    ],
  );

  const handleOpenChangedFile = useCallback(
    (filePath: string) => {
      if (!gitTargetPath) return;
      const fullPath = `${gitTargetPath}/${filePath}`;
      void openPath(fullPath);
    },
    [gitTargetPath],
  );
  const handleOpenWorkspaceChangedFile = useCallback((filePath: string) => {
    void openPath(filePath);
  }, []);

  const handleRefresh = useCallback(() => {
    void refetchAll();
  }, [refetchAll]);

  const toggleSection = useCallback(
    (section: ContextPanelSection) => {
      setSectionVisibility((prev) => ({
        ...prev,
        [section]: !prev[section],
      }));
    },
    [setSectionVisibility],
  );
  const isProjectContext = Boolean(projectName);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as ContextPanelTab)}
      className="flex max-h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-0 overflow-hidden"
    >
      <div className="shrink-0 px-4 pb-2 pt-2.5">
        <TabsList variant="weight">
          <TabsTrigger
            value="details"
            variant="weight"
            className={SIDEBAR_NAV_TEXT_CLASS}
          >
            {t("contextPanel.tabs.details")}
          </TabsTrigger>
          <TabsTrigger
            value="changes"
            variant="weight"
            className={SIDEBAR_NAV_TEXT_CLASS}
          >
            {t("contextPanel.tabs.changes")}
          </TabsTrigger>
          <TabsTrigger
            value="files"
            variant="weight"
            className={SIDEBAR_NAV_TEXT_CLASS}
          >
            {t("contextPanel.tabs.files")}
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="mx-4 shrink-0 border-b border-border/80" aria-hidden />

      <TabsContent value="details" className={TAB_CONTENT_CLASS}>
        <div className="-mt-0.5 w-full">
          {remoteHost !== null ? (
            <RemoteWorkspaceSummary
              host={remoteHost}
              workspacePath={gitTargetPath}
            />
          ) : isMultiWorkspaceMode ? (
            <>
              <WorkspaceWidget
                projectName={projectName}
                projectWorkingDirs={projectWorkingDirs}
                sessionWorkingDir={sessionWorkingDir}
                primaryWorkspaceRoot={gitTargetPath}
                fallbackGitState={fallbackGitState}
                fallbackIsLoading={fallbackGitIsLoading}
                fallbackIsFetching={fallbackGitIsFetching}
                fallbackError={
                  fallbackGitError instanceof Error ? fallbackGitError : null
                }
                workspaceRuntimes={workspaceGitRuntimes}
                isProjectContext={isProjectContext}
                onInitRepo={handleInitRepo}
                onChangeFolder={handleChangeFolder}
                onFetch={handleFetch}
                onPull={handlePull}
                onCreateBranch={handleCreateBranch}
                onCreateWorktree={handleCreateWorktree}
                onWorktreeCreated={handleWorkspaceWorktreeCreated}
                onSelectWorktree={handleWorkspaceWorktreeSelected}
                onSwitchBranch={handleWorkspaceSwitchBranch}
                onStashAndSwitch={handleWorkspaceStashAndSwitch}
                onAddWorkspace={() => setIsAddWorkspaceOpen(true)}
                onRemoveWorkspace={handleRemoveWorkspace}
                getRemovalPlan={getWorkspaceRemovalPlan}
                onOpenTerminalAtPath={onOpenTerminalAtPath}
                isChangingFolder={isChangingFolder}
              />
              <WorkspaceAddDialog
                open={isAddWorkspaceOpen}
                context="chat"
                currentProjectPath={gitTargetPath}
                includedWorkspaces={renderedWorkspaceAttachments}
                gitStateByWorkspaceId={workspaceGitStateById}
                onClose={() => setIsAddWorkspaceOpen(false)}
                onInclude={handleIncludeWorkspaceCandidate}
                onCreateWorktree={handleCreateWorktree}
                onIncludeCreatedWorktree={handleIncludeCreatedWorktree}
              />
            </>
          ) : (
            <LegacyWorkspaceWidget
              projectName={projectName}
              projectWorkingDirs={projectWorkingDirs}
              sessionWorkingDir={sessionWorkingDir}
              gitState={fallbackGitState}
              isLoading={fallbackGitIsLoading}
              isFetching={fallbackGitIsFetching}
              error={
                fallbackGitError instanceof Error ? fallbackGitError : null
              }
              activeContext={activeContext}
              onContextChange={handleContextChange}
              onSwitchBranch={handleSwitchBranch}
              onStashAndSwitch={handleStashAndSwitch}
              onInitRepo={handleInitRepo}
              onChangeFolder={handleChangeFolder}
              onFetch={handleFetch}
              onPull={handlePull}
              onCreateBranch={handleLegacyCreateBranch}
              onCreateWorktree={handleCreateWorktree}
              onRefresh={handleRefresh}
              isChangingFolder={isChangingFolder}
              isOpen={sectionVisibility.workspace}
              onToggleOpen={() => toggleSection("workspace")}
              terminalOpen={terminalOpen}
              onToggleTerminal={onToggleTerminal}
            />
          )}
          {shouldShowArtifacts && (
            <ArtifactsWidget
              isOpen={sectionVisibility.artifacts}
              onToggleOpen={() => toggleSection("artifacts")}
            />
          )}
        </div>
      </TabsContent>

      <TabsContent value="changes" className={TAB_CONTENT_CLASS}>
        <div className="w-full pb-4">
          {remoteHost !== null ? (
            <ChangesEmptyState
              message={t("remoteSessionGuards.changesUnavailable", {
                host: remoteHost,
              })}
            />
          ) : (
            <>
              {relatedPullRequestsEnabled && (
                <SessionPullRequestsWidget
                  sessionId={sessionId}
                  workspacePath={gitTargetPath}
                  isOpen={sectionVisibility.pullRequests}
                  onToggleOpen={() => toggleSection("pullRequests")}
                />
              )}
              {shouldShowChanges ? (
                hasWorkspaceAttachments ? (
                  <WorkspaceChangesWidget
                    groups={workspaceChangedFileRuntimes}
                    onOpenFile={handleOpenWorkspaceChangedFile}
                    probeErrorMessage={
                      changesProbeError
                        ? changesProbeError.message ||
                          t("contextPanel.errors.gitChangesRead")
                        : null
                    }
                  />
                ) : (
                  <ChangesWidget
                    files={fallbackChangedFiles}
                    isLoading={isFallbackFilesLoading}
                    error={
                      fallbackChangedFilesError instanceof Error
                        ? fallbackChangedFilesError
                        : null
                    }
                    isLoadingError={isFallbackChangedFilesLoadingError}
                    currentBranch={fallbackGitState?.currentBranch ?? null}
                    dirtyFileCount={fallbackGitState?.dirtyFileCount ?? 0}
                    repoPath={gitTargetPath ?? ""}
                    onOpenFile={handleOpenChangedFile}
                    isOpen={sectionVisibility.changes}
                    onToggleOpen={() => toggleSection("changes")}
                  />
                )
              ) : isChangesProbeLoading ? (
                <ChangesLoadingState />
              ) : changesProbeError ? (
                <ChangesErrorState
                  message={
                    changesProbeError.message ||
                    t("contextPanel.errors.gitChangesRead")
                  }
                />
              ) : (
                <ChangesEmptyState message={changesUnavailableMessage} />
              )}
            </>
          )}
        </div>
      </TabsContent>

      <TabsContent value="files" className={TAB_CONTENT_CLASS}>
        {remoteHost !== null ? (
          <p className="rounded-sm px-2 py-1 text-sm text-muted-foreground">
            {t("remoteSessionGuards.filesUnavailable", { host: remoteHost })}
          </p>
        ) : (
          <FilesList projectWorkingDirs={fileBrowserRoots} />
        )}
      </TabsContent>
    </Tabs>
  );
}
