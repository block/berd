import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderGit, FolderOpen, FolderPlus, GitFork, X } from "lucide-react";
import { ensureDirectory } from "@/shared/api/system";
import { getGitState } from "@/shared/api/git";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type {
  CreatedWorktree,
  GitState,
  WorktreeInfo,
} from "@/shared/types/git";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/shared/ui/select";
import { Spinner } from "@/shared/ui/spinner";
import {
  classifyWorkspaceAttachment,
  classifyWorkspaceAttachmentIfInGitState,
  getWorkspaceDisplayName,
  isSameWorkspacePath,
  normalizeComparableWorkspacePath,
  type ClassifiedWorkspaceAttachment,
} from "@/features/chat/lib/workspaceAttachments";
import {
  type CreatedWorkspaceWorktreeContext,
  WorkspaceCreateDialog,
} from "./WorkspaceCreateDialog";
import { shortenPath } from "./workspacePath";

export interface WorkspaceAddCandidate {
  path: string;
  gitState: GitState;
  classification: ClassifiedWorkspaceAttachment;
}

interface WorkspaceAddDialogProps {
  open: boolean;
  context?: "chat" | "project";
  currentProjectPath: string | null;
  includedWorkspaces: WorkspaceAttachment[];
  initialCandidate?: WorkspaceAddCandidate | null;
  includedWorkspaceIdToIgnore?: string | null;
  title?: string;
  submitLabel?: string;
  gitStateByWorkspaceId?: Record<string, GitState | undefined>;
  onClose: () => void;
  onInclude: (candidate: WorkspaceAddCandidate) => void;
  allowCreateWorktree?: boolean;
  onCreateWorktree?: (
    path: string,
    name: string,
    branch: string,
    createBranch: boolean,
    baseBranch?: string,
  ) => Promise<CreatedWorktree>;
  onIncludeCreatedWorktree?: (
    candidate: WorkspaceAddCandidate,
    worktree: CreatedWorktree,
    context: CreatedWorkspaceWorktreeContext,
  ) => void;
}

interface WorkspaceAddTriggerProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  iconClassName?: string;
  labelClassName?: string;
}

type WorkspaceRootKind = "folder" | "pick-directory" | "repo" | "worktree";

interface WorkspaceRootOption {
  id: string;
  label: string;
  description: string;
  path: string | null;
  kind: WorkspaceRootKind;
  icon: "folder" | "repo" | "worktree";
  gitState?: GitState;
}

interface WorkspaceWorktreeOption {
  id: string;
  label: string;
  description: string;
  path: string;
  branch: string | null;
  isMain: boolean;
  isAttached: boolean;
}

function createCandidate(
  path: string,
  gitState: GitState,
): WorkspaceAddCandidate {
  return {
    path,
    gitState,
    classification: classifyWorkspaceAttachment(path, gitState),
  };
}

function optionIdForPath(path: string) {
  return `path:${normalizeComparableWorkspacePath(path)}`;
}

function worktreeOptionIdForPath(path: string) {
  return `worktree:${normalizeComparableWorkspacePath(path)}`;
}

function isIncluded(
  path: string,
  includedWorkspaces: WorkspaceAttachment[],
  ignoredWorkspaceId?: string | null,
) {
  return includedWorkspaces.some(
    (workspace) =>
      workspace.id !== ignoredWorkspaceId &&
      isSameWorkspacePath(workspace.path, path),
  );
}

function gitStateForRootPath(
  path: string,
  gitState: GitState | undefined,
): GitState | undefined {
  if (!gitState?.isGitRepo) return undefined;
  return classifyWorkspaceAttachmentIfInGitState(path, gitState)
    ? gitState
    : undefined;
}

function displayNameForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const displayName = getWorkspaceDisplayName(path);
  return displayName === "." || displayName === ".." ? null : displayName;
}

function isDisplayablePath(path: string | null | undefined): path is string {
  return displayNameForPath(path) !== null;
}

function isLinkedWorktreeRoot(
  worktreePath: string | null | undefined,
  repositoryPath: string | null | undefined,
) {
  if (!isDisplayablePath(worktreePath)) return false;
  if (!isDisplayablePath(repositoryPath)) return true;
  return !isSameWorkspacePath(worktreePath, repositoryPath);
}

function repositoryPathForWorkspace(workspace: WorkspaceAttachment) {
  return (
    workspace.repositoryPath ??
    (workspace.kind === "git-main-worktree" || workspace.kind === "repository"
      ? workspace.path
      : null)
  );
}

function worktreePathForWorkspace(workspace: WorkspaceAttachment) {
  return (
    workspace.worktreePath ??
    (workspace.kind === "git-main-worktree" ||
    workspace.kind === "git-linked-worktree" ||
    workspace.kind === "git-detached-checkout" ||
    workspace.kind === "repository"
      ? workspace.path
      : null)
  );
}

function rootKindForCandidate(
  candidate: WorkspaceAddCandidate,
): Exclude<WorkspaceRootKind, "pick-directory"> {
  switch (candidate.classification.kind) {
    case "git-main-worktree":
    case "repository":
      return "repo";
    case "git-linked-worktree":
    case "git-detached-checkout":
      return "worktree";
    case "subdirectory":
      return isLinkedWorktreeRoot(
        candidate.classification.worktreePath,
        candidate.classification.repositoryPath,
      )
        ? "worktree"
        : "repo";
    case "directory":
    case "non-git-directory":
      return "folder";
  }
}

function rootPathForCandidate(candidate: WorkspaceAddCandidate): string {
  const rootKind = rootKindForCandidate(candidate);
  if (
    rootKind === "repo" &&
    isDisplayablePath(candidate.classification.repositoryPath)
  ) {
    return candidate.classification.repositoryPath;
  }
  if (
    (rootKind === "worktree" || rootKind === "repo") &&
    isDisplayablePath(candidate.classification.worktreePath)
  ) {
    return candidate.classification.worktreePath;
  }
  return candidate.path;
}

function rootIconForKind(kind: WorkspaceRootKind): WorkspaceRootOption["icon"] {
  if (kind === "repo") return "repo";
  if (kind === "worktree") return "worktree";
  return "folder";
}

function WorkspaceRootIcon({
  icon,
  className = "size-4",
}: {
  icon: WorkspaceRootOption["icon"];
  className?: string;
}) {
  if (icon === "worktree") {
    return (
      <GitFork className={`${className} shrink-0 text-muted-foreground`} />
    );
  }
  if (icon === "repo") {
    return (
      <FolderGit className={`${className} shrink-0 text-muted-foreground`} />
    );
  }
  return (
    <FolderOpen className={`${className} shrink-0 text-muted-foreground`} />
  );
}

export function WorkspaceAddTrigger({
  label,
  onClick,
  disabled = false,
  loading = false,
  className,
  iconClassName,
  labelClassName,
}: WorkspaceAddTriggerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={label}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-sm bg-muted/60 px-3.5 py-2.5 text-left text-sm text-foreground transition-colors",
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-muted/60",
        className,
      )}
    >
      {loading ? (
        <Spinner
          className={cn("size-4 shrink-0 text-muted-foreground", iconClassName)}
        />
      ) : (
        <FolderPlus
          className={cn("size-4 shrink-0 text-muted-foreground", iconClassName)}
          aria-hidden
        />
      )}
      <span className={cn("min-w-0 flex-1 truncate", labelClassName)}>
        {label}
      </span>
    </button>
  );
}

function WorkspaceRootOptionContent({
  option,
  compact = false,
}: {
  option: WorkspaceRootOption;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span className="relative flex min-w-0 flex-1 items-center justify-center px-7">
        <WorkspaceRootIcon
          icon={option.icon}
          className="absolute left-0 size-4"
        />
        <span className="min-w-0 max-w-full truncate text-center">
          {option.label}
        </span>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <WorkspaceRootIcon icon={option.icon} className="mt-0.5 size-4" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center">
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        </span>
        {!compact ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {option.description}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function rootDescription(
  kind: WorkspaceRootKind,
  path: string,
  branch: string | null | undefined,
  t: ReturnType<typeof useTranslation<"chat">>["t"],
) {
  if (kind === "repo") {
    return [
      t("contextPanel.addWorkspaceDialog.mainCheckout"),
      shortenPath(path),
    ].join(" - ");
  }
  if (kind === "worktree") {
    return [
      branch ?? t("contextPanel.states.detached"),
      shortenPath(path),
    ].join(" - ");
  }
  return shortenPath(path);
}

function createWorktreeOption({
  path,
  branch,
  isMain,
  isAttached,
  t,
}: {
  path: string;
  branch: string | null;
  isMain: boolean;
  isAttached: boolean;
  t: ReturnType<typeof useTranslation<"chat">>["t"];
}): WorkspaceWorktreeOption {
  return {
    id: worktreeOptionIdForPath(path),
    path,
    label: isMain
      ? t("contextPanel.addWorkspaceDialog.mainCheckout")
      : (displayNameForPath(path) ?? path),
    description: [
      branch ?? t("contextPanel.states.detached"),
      shortenPath(path),
    ].join(" - "),
    branch,
    isMain,
    isAttached,
  };
}

function mainWorktreeForRepo(
  repoPath: string,
  gitState: GitState,
): WorktreeInfo {
  const mainWorktree =
    gitState.worktrees.find((worktree) => worktree.isMain) ??
    gitState.worktrees.find((worktree) =>
      isSameWorkspacePath(worktree.path, gitState.mainWorktreePath),
    ) ??
    gitState.worktrees.find((worktree) =>
      isSameWorkspacePath(worktree.path, repoPath),
    );

  return (
    mainWorktree ?? {
      path: gitState.mainWorktreePath ?? repoPath,
      branch: gitState.currentBranch,
      isMain: true,
    }
  );
}

function useWorkspaceRootOptions({
  includedWorkspaces,
  gitStateByWorkspaceId,
  selectedRootCandidate,
  preferRepositoryRootForSelectedCandidate,
}: {
  includedWorkspaces: WorkspaceAttachment[];
  gitStateByWorkspaceId: Record<string, GitState | undefined>;
  selectedRootCandidate: WorkspaceAddCandidate | null;
  preferRepositoryRootForSelectedCandidate: boolean;
}) {
  const { t } = useTranslation("chat");

  return useMemo(() => {
    const options: WorkspaceRootOption[] = [];
    const seenPaths = new Set<string>();

    const addRoot = ({
      path,
      kind,
      branch,
      sourceGitState,
    }: {
      path: string | null | undefined;
      kind: Exclude<WorkspaceRootKind, "pick-directory">;
      branch?: string | null;
      sourceGitState?: GitState;
    }) => {
      if (!isDisplayablePath(path)) return;
      const id = optionIdForPath(path);
      if (seenPaths.has(id)) return;
      seenPaths.add(id);
      options.push({
        id,
        path,
        label: displayNameForPath(path) ?? path,
        description: rootDescription(kind, path, branch, t),
        kind,
        icon: rootIconForKind(kind),
        gitState: gitStateForRootPath(path, sourceGitState),
      });
    };

    for (const workspace of includedWorkspaces) {
      const workspaceGitState = gitStateByWorkspaceId[workspace.id];
      const repositoryPath =
        workspace.repositoryPath ??
        (workspace.kind === "git-main-worktree" ||
        workspace.kind === "repository"
          ? workspace.path
          : null);
      const worktreePath =
        workspace.worktreePath ??
        (workspace.kind === "git-linked-worktree" ||
        workspace.kind === "git-detached-checkout"
          ? workspace.path
          : null);

      if (isLinkedWorktreeRoot(worktreePath, repositoryPath)) {
        addRoot({
          path: worktreePath,
          kind: "worktree",
          branch: workspace.branch,
          sourceGitState: workspaceGitState,
        });
      }

      addRoot({
        path: repositoryPath,
        kind: "repo",
        branch: workspace.branch,
        sourceGitState: workspaceGitState,
      });

      if (!repositoryPath && !worktreePath) {
        addRoot({
          path: workspace.path,
          kind: "folder",
          sourceGitState: workspaceGitState,
        });
      }
    }

    if (selectedRootCandidate) {
      const kind =
        preferRepositoryRootForSelectedCandidate &&
        isDisplayablePath(selectedRootCandidate.classification.repositoryPath)
          ? "repo"
          : rootKindForCandidate(selectedRootCandidate);
      const path =
        kind === "repo"
          ? selectedRootCandidate.classification.repositoryPath
          : rootPathForCandidate(selectedRootCandidate);
      addRoot({
        path,
        kind,
        branch: selectedRootCandidate.classification.branch,
        sourceGitState: selectedRootCandidate.gitState,
      });
    }

    options.push({
      id: "pick-directory",
      label: t("contextPanel.addWorkspaceDialog.pickDirectory"),
      description: t(
        "contextPanel.addWorkspaceDialog.pickDirectoryDescription",
      ),
      path: null,
      kind: "pick-directory",
      icon: "folder",
    });

    return options;
  }, [
    gitStateByWorkspaceId,
    includedWorkspaces,
    preferRepositoryRootForSelectedCandidate,
    selectedRootCandidate,
    t,
  ]);
}

function useWorkspaceWorktreeOptions({
  includedWorkspaces,
  selectedRoot,
  selectedRootGitState,
}: {
  includedWorkspaces: WorkspaceAttachment[];
  selectedRoot: WorkspaceRootOption | null;
  selectedRootGitState: GitState | undefined;
}) {
  const { t } = useTranslation("chat");

  return useMemo(() => {
    if (
      selectedRoot?.kind !== "repo" ||
      !selectedRoot.path ||
      !selectedRootGitState?.isGitRepo
    ) {
      return [];
    }

    const repoPath = selectedRoot.path;
    const options: WorkspaceWorktreeOption[] = [];
    const seenPaths = new Set<string>();
    const addOption = ({
      path,
      branch,
      isMain,
      isAttached,
    }: {
      path: string | null | undefined;
      branch: string | null | undefined;
      isMain: boolean;
      isAttached: boolean;
    }) => {
      if (!isDisplayablePath(path)) return;
      const id = worktreeOptionIdForPath(path);
      if (seenPaths.has(id)) return;
      seenPaths.add(id);
      options.push(
        createWorktreeOption({
          path,
          branch: branch ?? null,
          isMain,
          isAttached,
          t,
        }),
      );
    };

    const mainWorktree = mainWorktreeForRepo(repoPath, selectedRootGitState);
    addOption({
      path: mainWorktree.path,
      branch: mainWorktree.branch,
      isMain: true,
      isAttached: true,
    });

    for (const workspace of includedWorkspaces) {
      const repositoryPath = repositoryPathForWorkspace(workspace);
      const worktreePath = worktreePathForWorkspace(workspace);
      if (
        !repositoryPath ||
        !worktreePath ||
        !isSameWorkspacePath(repositoryPath, repoPath) ||
        isSameWorkspacePath(worktreePath, mainWorktree.path)
      ) {
        continue;
      }

      const matchingWorktree = selectedRootGitState.worktrees.find((worktree) =>
        isSameWorkspacePath(worktree.path, worktreePath),
      );
      addOption({
        path: worktreePath,
        branch: matchingWorktree?.branch ?? workspace.branch,
        isMain: false,
        isAttached: true,
      });
    }

    for (const worktree of selectedRootGitState.worktrees) {
      if (
        worktree.isMain ||
        isSameWorkspacePath(worktree.path, mainWorktree.path)
      ) {
        continue;
      }
      addOption({
        path: worktree.path,
        branch: worktree.branch,
        isMain: false,
        isAttached: false,
      });
    }

    return options;
  }, [includedWorkspaces, selectedRoot, selectedRootGitState, t]);
}

function WorkspaceWorktreeOptionContent({
  option,
  compact = false,
}: {
  option: WorkspaceWorktreeOption;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span className="relative flex min-w-0 flex-1 items-center justify-center px-7">
        {option.isMain ? (
          <FolderGit className="absolute left-0 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <GitFork className="absolute left-0 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 max-w-full truncate text-center">
          {option.label}
        </span>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      {option.isMain ? (
        <FolderGit className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <GitFork className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center">
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        </span>
        {!compact ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {option.description}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function projectFolderDetectionIcon(
  candidate: WorkspaceAddCandidate,
): WorkspaceRootOption["icon"] {
  switch (candidate.classification.kind) {
    case "repository":
    case "git-main-worktree":
      return "repo";
    case "git-linked-worktree":
    case "git-detached-checkout":
      return "worktree";
    case "subdirectory":
    case "directory":
    case "non-git-directory":
      return "folder";
  }
}

function ProjectFolderSelectionContent({
  candidate,
  t,
}: {
  candidate: WorkspaceAddCandidate | null;
  t: ReturnType<typeof useTranslation<"chat">>["t"];
}) {
  if (!candidate) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
        <FolderOpen className="size-4 shrink-0" />
        <span className="truncate">
          {t("contextPanel.addWorkspaceDialog.folderPlaceholder")}
        </span>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-1 items-start gap-2 text-left">
      <WorkspaceRootIcon
        icon={projectFolderDetectionIcon(candidate)}
        className="mt-0.5 size-4"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {displayNameForPath(candidate.path) ?? candidate.path}
        </span>
      </span>
    </span>
  );
}

export function WorkspaceAddDialog({
  open,
  context = "chat",
  currentProjectPath,
  includedWorkspaces,
  initialCandidate = null,
  includedWorkspaceIdToIgnore = null,
  title,
  submitLabel,
  gitStateByWorkspaceId = {},
  onClose,
  onInclude,
  allowCreateWorktree = true,
  onCreateWorktree,
  onIncludeCreatedWorktree,
}: WorkspaceAddDialogProps) {
  const { t } = useTranslation(["chat", "common"]);
  const closeLabel = t("labels.close", { ns: "common" });
  const isProjectContext = context === "project";
  const dialogTitle =
    title ??
    t(
      isProjectContext
        ? "contextPanel.addWorkspaceDialog.projectTitle"
        : "contextPanel.addWorkspaceDialog.title",
    );
  const chooseFolderLabel = t(
    isProjectContext
      ? "contextPanel.addWorkspaceDialog.chooseFolder"
      : "contextPanel.addWorkspaceDialog.addAnotherWorkspace",
  );
  const chooseFolderDialogTitle = t(
    isProjectContext
      ? "contextPanel.addWorkspaceDialog.chooseFolderDialogTitle"
      : "contextPanel.addWorkspaceDialog.chooseWorkspace",
  );
  const addErrorMessage = t(
    isProjectContext
      ? "contextPanel.addWorkspaceDialog.projectError"
      : "contextPanel.addWorkspaceDialog.error",
  );
  const rootSelectLabel = t(
    isProjectContext
      ? "contextPanel.addWorkspaceDialog.folder"
      : "contextPanel.addWorkspaceDialog.localRepo",
  );
  const [selectedCandidate, setSelectedCandidate] =
    useState<WorkspaceAddCandidate | null>(null);
  const [selectedRootCandidate, setSelectedRootCandidate] =
    useState<WorkspaceAddCandidate | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(
    null,
  );
  const [rootGitStates, setRootGitStates] = useState<Record<string, GitState>>(
    {},
  );
  const [loadingRootGitStatePath, setLoadingRootGitStatePath] = useState<
    string | null
  >(null);
  const [createCandidateSource, setCreateCandidateSource] =
    useState<WorkspaceAddCandidate | null>(null);
  const [createWorktree, setCreateWorktree] = useState(false);
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const rootOptions = useWorkspaceRootOptions({
    includedWorkspaces,
    gitStateByWorkspaceId,
    selectedRootCandidate,
    preferRepositoryRootForSelectedCandidate: isProjectContext,
  });

  useEffect(() => {
    if (!open) return;
    if (
      selectedRootId &&
      rootOptions.some((option) => option.id === selectedRootId)
    ) {
      return;
    }
    setSelectedRootId(isProjectContext ? null : (rootOptions[0]?.id ?? null));
  }, [isProjectContext, open, rootOptions, selectedRootId]);

  const selectedRoot =
    rootOptions.find((option) => option.id === selectedRootId) ??
    (isProjectContext
      ? rootOptions.find((option) => option.id === "pick-directory")
      : rootOptions[0]) ??
    null;
  const selectedRootComparablePath = selectedRoot?.path
    ? normalizeComparableWorkspacePath(selectedRoot.path)
    : null;
  const selectedRootGitState =
    selectedRoot?.gitState ??
    (selectedRootComparablePath
      ? rootGitStates[selectedRootComparablePath]
      : undefined);
  const worktreeOptions = useWorkspaceWorktreeOptions({
    includedWorkspaces,
    selectedRoot,
    selectedRootGitState,
  });
  const selectedWorktree =
    worktreeOptions.find((option) => option.id === selectedWorktreeId) ??
    worktreeOptions[0] ??
    null;
  const selectedDirectoryPath =
    selectedCandidate?.path ??
    selectedWorktree?.path ??
    selectedRoot?.path ??
    null;
  const directoryPickerDefaultPath =
    selectedWorktree?.path ?? selectedRoot?.path ?? currentProjectPath;
  const canCreateWorktreeFromRoot =
    allowCreateWorktree &&
    Boolean(onCreateWorktree) &&
    Boolean(onIncludeCreatedWorktree) &&
    selectedRoot?.kind === "repo" &&
    selectedWorktree?.isMain !== false;
  const addDisabled =
    isAdding ||
    isChoosingFolder ||
    !selectedDirectoryPath ||
    (!createWorktree &&
      isIncluded(
        selectedDirectoryPath,
        includedWorkspaces,
        includedWorkspaceIdToIgnore,
      ));

  const resetAndClose = () => {
    setSelectedCandidate(null);
    setSelectedRootCandidate(null);
    setSelectedRootId(null);
    setSelectedWorktreeId(null);
    setCreateCandidateSource(null);
    setCreateWorktree(false);
    setIsAdding(false);
    onClose();
  };

  const selectCandidate = useCallback(
    (
      candidate: WorkspaceAddCandidate,
      previousRepoRoot?: WorkspaceRootOption | null,
    ) => {
      const candidateRepositoryPath = candidate.classification.repositoryPath;
      const candidateWorktreePath = candidate.classification.worktreePath;
      const candidateRepositoryRoot =
        isProjectContext && isDisplayablePath(candidateRepositoryPath)
          ? candidateRepositoryPath
          : null;
      const shouldPreservePreviousRepoRoot =
        previousRepoRoot?.path &&
        candidateRepositoryPath &&
        isSameWorkspacePath(candidateRepositoryPath, previousRepoRoot.path);
      const nextRootPath =
        shouldPreservePreviousRepoRoot && previousRepoRoot?.path
          ? previousRepoRoot.path
          : candidateRepositoryRoot
            ? candidateRepositoryRoot
            : rootPathForCandidate(candidate);
      const nextWorktreePath =
        shouldPreservePreviousRepoRoot || candidateRepositoryRoot
          ? (candidateWorktreePath ?? candidateRepositoryRoot ?? nextRootPath)
          : null;

      setSelectedCandidate(candidate);
      setSelectedRootCandidate(candidate);
      setSelectedRootId(
        shouldPreservePreviousRepoRoot && previousRepoRoot
          ? previousRepoRoot.id
          : optionIdForPath(nextRootPath),
      );
      setSelectedWorktreeId(
        nextWorktreePath ? worktreeOptionIdForPath(nextWorktreePath) : null,
      );
      setCreateWorktree(false);
    },
    [isProjectContext],
  );

  useEffect(() => {
    if (!open || !initialCandidate) return;
    selectCandidate(initialCandidate);
  }, [open, initialCandidate, selectCandidate]);

  const chooseFolder = async (defaultPath?: string | null) => {
    setIsChoosingFolder(true);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        defaultPath: defaultPath ?? undefined,
        directory: true,
        multiple: false,
        title: chooseFolderDialogTitle,
      });
      if (typeof selected !== "string") {
        return;
      }

      await ensureDirectory(selected);
      const selectedGitState = await getGitState(selected);
      const candidate = createCandidate(selected, selectedGitState);
      const previousRepoRoot =
        selectedRoot?.kind === "repo" && selectedRoot.path
          ? selectedRoot
          : null;
      selectCandidate(candidate, previousRepoRoot);
    } catch (error) {
      console.warn("Failed to choose workspace folder:", error);
      toast.error(addErrorMessage);
    } finally {
      setIsChoosingFolder(false);
    }
  };

  const resolveCandidateForAdd = async () => {
    if (selectedCandidate) return selectedCandidate;
    const path = selectedDirectoryPath;
    if (!selectedRoot?.path || !path) return null;
    const selectedGitState =
      selectedRootGitState ?? (await getGitState(selectedRoot.path));
    return createCandidate(path, selectedGitState);
  };

  const handleAdd = async () => {
    if (!selectedRoot?.path && !selectedCandidate) {
      await chooseFolder(null);
      return;
    }

    setIsAdding(true);
    try {
      const candidate = await resolveCandidateForAdd();
      if (!candidate) return;
      if (createWorktree && canCreateWorktreeFromRoot) {
        setCreateCandidateSource(candidate);
        return;
      }
      onInclude(candidate);
      resetAndClose();
    } catch (error) {
      console.warn("Failed to add workspace:", error);
      toast.error(addErrorMessage);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRootChange = (value: string) => {
    if (value === "pick-directory") {
      void chooseFolder(directoryPickerDefaultPath);
      return;
    }
    const nextRoot = rootOptions.find((option) => option.id === value);
    const nextRootPath = nextRoot?.path;
    if (isProjectContext && nextRoot?.kind === "worktree" && nextRootPath) {
      if (nextRoot.gitState) {
        selectCandidate(createCandidate(nextRootPath, nextRoot.gitState));
      } else {
        void getGitState(nextRootPath)
          .then((gitState) =>
            selectCandidate(createCandidate(nextRootPath, gitState)),
          )
          .catch((error) => {
            console.warn("Failed to load workspace folder:", error);
            toast.error(addErrorMessage);
          });
      }
      return;
    }
    setSelectedRootId(value);
    setSelectedCandidate(null);
    setSelectedWorktreeId(null);
    setCreateWorktree(false);
  };

  const handleWorktreeChange = (value: string) => {
    setSelectedWorktreeId(value);
    setSelectedCandidate(null);
    setCreateWorktree(false);
  };

  const handleCreatedWorktree = (
    worktree: CreatedWorktree,
    context: CreatedWorkspaceWorktreeContext,
  ) => {
    if (!createCandidateSource) return;
    onIncludeCreatedWorktree?.(createCandidateSource, worktree, context);
    setCreateCandidateSource(null);
    resetAndClose();
  };

  const selectedDirectoryDescription =
    selectedDirectoryPath ??
    t("contextPanel.addWorkspaceDialog.pickDirectoryDescription");
  const shouldShowWorktreeSelect = selectedRoot?.kind === "repo";
  const isLoadingSelectedRootGitState =
    Boolean(selectedRoot?.path) &&
    loadingRootGitStatePath === selectedRootComparablePath;

  useEffect(() => {
    if (!open || selectedRoot?.kind !== "repo" || !selectedRoot.path) return;
    const comparablePath = normalizeComparableWorkspacePath(selectedRoot.path);
    if (selectedRoot.gitState || rootGitStates[comparablePath]) return;

    let isCurrent = true;
    setLoadingRootGitStatePath(comparablePath);
    getGitState(selectedRoot.path)
      .then((nextGitState) => {
        if (!isCurrent) return;
        setRootGitStates((current) => ({
          ...current,
          [comparablePath]: nextGitState,
        }));
      })
      .catch((error) => {
        if (!isCurrent) return;
        console.warn("Failed to load worktrees for workspace root:", error);
      })
      .finally(() => {
        if (!isCurrent) return;
        setLoadingRootGitStatePath(null);
      });

    return () => {
      isCurrent = false;
    };
  }, [open, rootGitStates, selectedRoot]);

  useEffect(() => {
    if (!open || selectedRoot?.kind !== "repo") {
      if (selectedWorktreeId !== null) {
        setSelectedWorktreeId(null);
      }
      return;
    }

    if (
      selectedWorktreeId &&
      worktreeOptions.some((option) => option.id === selectedWorktreeId)
    ) {
      return;
    }

    setSelectedWorktreeId(worktreeOptions[0]?.id ?? null);
  }, [open, selectedRoot?.kind, selectedWorktreeId, worktreeOptions]);

  useEffect(() => {
    if (!canCreateWorktreeFromRoot && createWorktree) {
      setCreateWorktree(false);
    }
  }, [canCreateWorktreeFromRoot, createWorktree]);

  const workspacePickerContent = isProjectContext ? (
    <div className="space-y-4 px-6 pb-5 sm:px-10">
      <div className="space-y-1.5">
        <button
          id="workspace-folder-button"
          type="button"
          aria-label={rootSelectLabel}
          onClick={() => void chooseFolder(directoryPickerDefaultPath)}
          disabled={isChoosingFolder || isAdding}
          className={cn(
            "flex h-12 w-full min-w-0 items-center rounded-[12px] bg-background px-3 py-2 text-sm shadow-none transition-colors",
            "border border-input hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-70",
          )}
        >
          {isChoosingFolder ? (
            <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
              <Spinner className="size-4 shrink-0" />
              <span className="truncate">
                {t("contextPanel.addWorkspaceDialog.folderPlaceholder")}
              </span>
            </span>
          ) : (
            <ProjectFolderSelectionContent
              candidate={selectedCandidate}
              t={t}
            />
          )}
        </button>
        {selectedCandidate ? (
          <p className="break-words text-xs leading-4 text-muted-foreground">
            {selectedCandidate.path}
          </p>
        ) : null}
      </div>
    </div>
  ) : (
    <div className="space-y-4 px-6 pb-5 sm:px-10">
      <div className="space-y-1.5">
        <label
          htmlFor="workspace-root-select"
          className="text-sm font-normal leading-5 text-foreground"
        >
          {rootSelectLabel}
        </label>
        <Select value={selectedRootId ?? ""} onValueChange={handleRootChange}>
          <SelectTrigger
            id="workspace-root-select"
            aria-label={rootSelectLabel}
            className="h-12 w-full rounded-[12px] bg-background px-3 py-2 shadow-none"
          >
            {selectedRoot && selectedRoot.kind !== "pick-directory" ? (
              <WorkspaceRootOptionContent option={selectedRoot} compact />
            ) : (
              <span className="truncate text-muted-foreground">
                {t("contextPanel.addWorkspaceDialog.noDirectorySelected")}
              </span>
            )}
          </SelectTrigger>
          <SelectContent className="w-[var(--radix-select-trigger-width)]">
            {rootOptions.map((option) => (
              <SelectItem
                key={option.id}
                value={option.id}
                textValue={`${option.label} ${option.description}`}
                className="items-start py-1.5"
              >
                <WorkspaceRootOptionContent option={option} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedDirectoryPath ? (
          <p className="truncate text-xs text-muted-foreground">
            {shortenPath(selectedDirectoryDescription)}
          </p>
        ) : null}
      </div>

      {shouldShowWorktreeSelect ? (
        <div className="space-y-1.5">
          <label
            htmlFor="workspace-worktree-select"
            className="text-sm font-normal leading-5 text-foreground"
          >
            {t("contextPanel.addWorkspaceDialog.worktree")}
          </label>
          <Select
            value={selectedWorktree?.id ?? ""}
            onValueChange={handleWorktreeChange}
            disabled={
              isLoadingSelectedRootGitState || worktreeOptions.length === 0
            }
          >
            <SelectTrigger
              id="workspace-worktree-select"
              aria-label={t("contextPanel.addWorkspaceDialog.worktree")}
              className="h-12 w-full rounded-[12px] bg-background px-3 py-2 shadow-none"
            >
              {isLoadingSelectedRootGitState ? (
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <Spinner className="size-4" />
                  <span className="truncate">
                    {t("contextPanel.addWorkspaceDialog.loadingWorktrees")}
                  </span>
                </span>
              ) : selectedWorktree ? (
                <WorkspaceWorktreeOptionContent
                  option={selectedWorktree}
                  compact
                />
              ) : (
                <span className="truncate text-muted-foreground">
                  {t("contextPanel.addWorkspaceDialog.worktreePlaceholder")}
                </span>
              )}
            </SelectTrigger>
            <SelectContent className="w-[var(--radix-select-trigger-width)]">
              {worktreeOptions.map((option) => (
                <SelectItem
                  key={option.id}
                  value={option.id}
                  textValue={`${option.label} ${option.description}`}
                  className="items-start py-1.5"
                >
                  <WorkspaceWorktreeOptionContent option={option} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <Button
        type="button"
        variant="subtle"
        size="sm"
        onClick={() => void chooseFolder(directoryPickerDefaultPath)}
        disabled={isChoosingFolder || isAdding}
        className="h-10 px-5 text-sm font-normal"
      >
        {isChoosingFolder ? <Spinner className="size-4" /> : null}
        {chooseFolderLabel}
      </Button>

      {canCreateWorktreeFromRoot ? (
        <div className="flex items-start gap-2 pt-1 text-sm text-foreground">
          <Checkbox
            id="workspace-add-create-worktree"
            aria-describedby="workspace-add-create-worktree-description"
            checked={createWorktree}
            onCheckedChange={(checked) => setCreateWorktree(checked === true)}
            className="mt-0.5"
          />
          <label htmlFor="workspace-add-create-worktree" className="min-w-0">
            <span className="block">
              {t("contextPanel.addWorkspaceDialog.createWorktree")}
            </span>
            <span
              id="workspace-add-create-worktree-description"
              className="block text-xs text-muted-foreground"
            >
              {t("contextPanel.addWorkspaceDialog.createWorktreeDescription")}
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <Dialog
        open={open && !createCandidateSource}
        onOpenChange={(nextOpen) => !nextOpen && resetAndClose()}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-[600px] gap-0 overflow-hidden rounded-[24px] bg-background p-0 shadow-[0_24px_70px_rgba(0,0,0,0.22)]"
        >
          <DialogClose asChild>
            <button
              type="button"
              className="absolute right-6 top-10 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={closeLabel}
            >
              <X className="size-5" aria-hidden />
              <span className="sr-only">{closeLabel}</span>
            </button>
          </DialogClose>

          <DialogHeader className="gap-1 px-6 pb-6 pt-7 pr-16 sm:pl-10 sm:pr-16">
            <DialogTitle className="text-[20px] font-semibold leading-6 tracking-normal">
              {dialogTitle}
            </DialogTitle>
            <DialogDescription className="text-sm leading-5 text-muted-foreground">
              {t(
                isProjectContext
                  ? "contextPanel.addWorkspaceDialog.projectDescription"
                  : "contextPanel.addWorkspaceDialog.description",
              )}
            </DialogDescription>
          </DialogHeader>

          {workspacePickerContent}

          <DialogFooter className="border-t bg-muted/20 px-6 py-3.5 sm:px-10">
            <Button
              type="button"
              variant="ghost"
              size="default"
              onClick={resetAndClose}
              flush
              className="h-10 px-5 text-sm font-medium"
            >
              {t("contextPanel.addWorkspaceDialog.cancel")}
            </Button>
            <Button
              type="button"
              size="default"
              onClick={() => void handleAdd()}
              disabled={addDisabled}
              className="h-10 min-w-[96px] px-6 text-sm font-medium"
            >
              {isAdding ? <Spinner className="size-4" /> : null}
              {submitLabel ?? t("contextPanel.addWorkspaceDialog.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {createCandidateSource ? (
        <WorkspaceCreateDialog
          mode="worktree"
          gitState={createCandidateSource.gitState}
          currentPath={
            createCandidateSource.classification.worktreePath ??
            createCandidateSource.path
          }
          activeBranch={
            createCandidateSource.classification.branch ??
            createCandidateSource.gitState.currentBranch
          }
          onClose={() => setCreateCandidateSource(null)}
          onCreateBranch={async () => undefined}
          onCreateWorktree={onCreateWorktree}
          onWorktreeCreated={handleCreatedWorktree}
        />
      ) : null}
    </>
  );
}
