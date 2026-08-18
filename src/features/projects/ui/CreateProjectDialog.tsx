import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconFolderPlus,
  IconTrash,
} from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { getGitState } from "@/shared/api/git";
import { checkDirectoriesExist, resolvePath } from "@/shared/api/pathResolver";
import { ensureDirectory } from "@/shared/api/system";
import type { GitState } from "@/shared/types/git";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import {
  createProject,
  normalizeProjectWorkspaces,
  projectWorkspaceFromDirectory,
  updateProject,
  type ProjectInfo,
  type ProjectWorkspace,
  type ProjectWorkspaceStartupMode,
  isWorktreeStartupMode,
} from "../api/projects";
import {
  classifyWorkspaceAttachment,
  enrichWorkspaceAttachmentWithGitState,
  getWorkspaceDisplayName,
  isSameWorkspacePath,
  normalizeComparableWorkspacePath,
} from "@/features/chat/lib/workspaceAttachments";
import {
  WorkspaceAddTrigger,
  type WorkspaceAddCandidate,
} from "@/features/chat/ui/widgets/WorkspaceAddDialog";
import { WorkspaceIdentity } from "@/features/chat/ui/widgets/WorkspaceIdentity";
import {
  trackProjectCreateCompleted,
  trackProjectEditCompleted,
} from "../lib/projectTelemetry";
import { buildEditorText, parseEditorText } from "../lib/projectPromptText";
import { useProjectIconSelection } from "../hooks/useProjectIconSelection";
import { DEFAULT_PROJECT_ICON } from "../lib/projectIcons";
import { DEFAULT_PROJECT_COLOR } from "../lib/projectDefaults";
import { pillCssColor } from "../lib/pillTones";
import { ProjectColorPicker } from "./ProjectColorPicker";
import { panelLabelClass } from "./panelStyles";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { ProjectArtifactPreview } from "../artifact/ProjectArtifactPreview";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";

/* Shared recipe for the panel's flat card-surface fields (name input, folder
   picker, description textarea). The light-mode hover/focus shadow is
   imperceptible on dark surfaces, so a ring-token focus cue carries
   keyboard-focus visibility in both themes. */
const panelFieldClass =
  "rounded-sm border-0 bg-card text-[14px] leading-[15px] text-card-foreground shadow-none outline-none transition-[box-shadow,background-color] duration-200 placeholder:text-card-foreground/30 hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)]";

function getDefaultProjectName(path: string | null | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function configuredWorktreeStartupMode(
  mode: ProjectWorkspaceStartupMode,
): "ask-worktree" | "auto-worktree" | null {
  if (mode === "worktree" || mode === "auto-worktree") {
    return "auto-worktree";
  }
  return mode === "ask-worktree" ? mode : null;
}

function projectWorkspaceStartupModeLabel(
  mode: ProjectWorkspaceStartupMode,
  t: ReturnType<typeof useTranslation<"projects">>["t"],
) {
  switch (mode) {
    case "worktree":
    case "ask-worktree":
      return t("dialog.workspacePolicy.askWorktree");
    case "auto-worktree":
      return t("dialog.workspacePolicy.autoWorktree");
    case "branch":
      return t("dialog.workspacePolicy.createBranch");
    case "none":
      return t("dialog.workspacePolicy.noWorktree");
  }
}

function defaultStartupModeForCandidate(
  _candidate: WorkspaceAddCandidate,
  _projectWorkspaces: ProjectWorkspace[] = [],
): ProjectWorkspaceStartupMode {
  return "none";
}

function repositoryPathForProjectWorkspace(
  workspace: Pick<ProjectWorkspace, "kind" | "path" | "repositoryPath">,
): string | null {
  return (
    workspace.repositoryPath ??
    (workspace.kind === "git-main-worktree" || workspace.kind === "repository"
      ? workspace.path
      : null)
  );
}

function startupPolicyRepositoryKey(
  workspace: ProjectWorkspace,
): string | null {
  const repositoryPath = repositoryPathForProjectWorkspace(workspace);
  return repositoryPath
    ? normalizeComparableWorkspacePath(repositoryPath)
    : null;
}

function startupPolicyCheckoutKey(workspace: ProjectWorkspace): string | null {
  const checkoutPath =
    workspace.worktreePath ??
    (hasGitWorkspaceKind(workspace) ? workspace.path : null) ??
    repositoryPathForProjectWorkspace(workspace);
  return checkoutPath ? normalizeComparableWorkspacePath(checkoutPath) : null;
}

function startupPolicySyncKey(
  workspace: ProjectWorkspace,
  startupMode: ProjectWorkspaceStartupMode,
): string | null {
  const repositoryKey = startupPolicyRepositoryKey(workspace);
  if (!repositoryKey) {
    return null;
  }

  if (startupMode !== "branch") {
    return repositoryKey;
  }

  const checkoutKey = startupPolicyCheckoutKey(workspace);
  return checkoutKey ? `${repositoryKey}:${checkoutKey}` : null;
}

function startupPolicyCandidateRepositoryKey(
  candidate: WorkspaceAddCandidate,
): string | null {
  const repositoryPath = candidate.classification.repositoryPath;
  return repositoryPath
    ? normalizeComparableWorkspacePath(repositoryPath)
    : null;
}

function startupPolicyCandidateCheckoutKey(
  candidate: WorkspaceAddCandidate,
): string | null {
  const { kind, repositoryPath, worktreePath } = candidate.classification;
  const checkoutPath =
    worktreePath ??
    (kind === "git-main-worktree" ||
    kind === "git-linked-worktree" ||
    kind === "git-detached-checkout" ||
    kind === "repository"
      ? candidate.path
      : null) ??
    repositoryPath;
  return checkoutPath ? normalizeComparableWorkspacePath(checkoutPath) : null;
}

function startupPolicyCandidateSyncKey(
  candidate: WorkspaceAddCandidate,
  startupMode: ProjectWorkspaceStartupMode,
): string | null {
  const repositoryKey = startupPolicyCandidateRepositoryKey(candidate);
  if (!repositoryKey) {
    return null;
  }

  if (startupMode !== "branch") {
    return repositoryKey;
  }

  const checkoutKey = startupPolicyCandidateCheckoutKey(candidate);
  return checkoutKey ? `${repositoryKey}:${checkoutKey}` : null;
}

function workspaceStartupModeAppliesToCandidate(
  candidate: WorkspaceAddCandidate,
  workspace: ProjectWorkspace,
): boolean {
  const candidateSyncKey = startupPolicyCandidateSyncKey(
    candidate,
    workspace.startupMode,
  );
  return Boolean(
    candidateSyncKey &&
      startupPolicySyncKey(workspace, workspace.startupMode) ===
        candidateSyncKey,
  );
}

function nonNoneStartupModeFromProjectWorkspaceContext(
  candidate: WorkspaceAddCandidate,
  projectWorkspaces: ProjectWorkspace[],
): ProjectWorkspaceStartupMode | null {
  for (const workspace of projectWorkspaces) {
    if (workspace.startupMode === "none") {
      continue;
    }

    if (workspaceStartupModeAppliesToCandidate(candidate, workspace)) {
      return workspace.startupMode;
    }
  }

  return null;
}

function projectWorkspaceFromCandidate(
  candidate: WorkspaceAddCandidate,
  projectWorkspaces: ProjectWorkspace[] = [],
): ProjectWorkspace {
  return {
    id: `path:${candidate.path}`,
    path: candidate.path,
    kind: candidate.classification.kind,
    source: "selected",
    branch: candidate.classification.branch,
    repositoryPath: candidate.classification.repositoryPath,
    worktreePath: candidate.classification.worktreePath,
    usedByAgent: false,
    startupMode: defaultStartupModeForCandidate(candidate, projectWorkspaces),
  };
}

function workspaceAddCandidateFromDirectory(
  path: string,
  gitState: GitState,
): WorkspaceAddCandidate {
  return {
    path,
    gitState,
    classification: classifyWorkspaceAttachment(path, gitState),
  };
}

function hasGitWorkspaceKind(workspace: Pick<ProjectWorkspace, "kind">) {
  return (
    workspace.kind === "repository" ||
    workspace.kind === "git-main-worktree" ||
    workspace.kind === "git-linked-worktree" ||
    workspace.kind === "git-detached-checkout"
  );
}

function workspaceUsesLinkedWorktree(workspace: ProjectWorkspace): boolean {
  if (
    workspace.kind === "git-linked-worktree" ||
    workspace.kind === "git-detached-checkout"
  ) {
    return true;
  }

  return Boolean(
    workspace.repositoryPath &&
      workspace.worktreePath &&
      !isSameWorkspacePath(workspace.repositoryPath, workspace.worktreePath),
  );
}

function startupModeOptionsForWorkspace(): ProjectWorkspaceStartupMode[] {
  return ["ask-worktree", "auto-worktree"];
}

function startupModeAllowedForWorkspace(
  workspace: ProjectWorkspace,
  startupMode: ProjectWorkspaceStartupMode,
): boolean {
  return (
    startupMode === "none" ||
    hasGitWorkspaceKind(workspace) ||
    Boolean(workspace.repositoryPath)
  );
}

interface CreateProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
  initialWorkingDir?: string | null;
  editingProject?: ProjectInfo;
  modal?: boolean;
}

export function CreateProjectDialog({
  isOpen,
  onClose,
  onCreated,
  initialWorkingDir,
  editingProject,
  modal = true,
}: CreateProjectDialogProps) {
  const { t } = useTranslation(["projects", "common"]);
  const workspaceRepository = useWorkspaceRepository();
  const isMultiWorkspaceMode = workspaceRepository.mode === "multi";
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectWorkspaces, setProjectWorkspaces] = useState<
    ProjectWorkspace[]
  >([]);
  const workingDirs = useMemo(
    () => projectWorkspaces.map((workspace) => workspace.path),
    [projectWorkspaces],
  );
  const [workingDir, setWorkingDir] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLOR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPreparingAddWorkspace, setIsPreparingAddWorkspace] = useState(false);
  const [
    pendingWorktreePolicyWorkspaceId,
    setPendingWorktreePolicyWorkspaceId,
  ] = useState<string | null>(null);
  const [projectWorkspaceGitStates, setProjectWorkspaceGitStates] = useState<
    Record<string, GitState>
  >({});
  const [confirmedNonGitWorkspaceIds, setConfirmedNonGitWorkspaceIds] =
    useState<Set<string>>(() => new Set());
  const {
    icon,
    iconCandidates,
    iconError,
    chooseIcon,
    chooseCustomIcon,
    resetIcon,
  } = useProjectIconSelection({
    isOpen,
    prompt: buildEditorText(workingDirs, prompt),
  });
  // Working directories that don't currently exist on disk, surfaced as a
  // warning on the workspace field so users can fix the paths before saving.
  const [missingDirs, setMissingDirs] = useState<string[]>([]);

  const isEditing = !!editingProject;

  // Re-check the configured folders against the filesystem whenever they
  // change while the dialog is open. All workingDirs are validated, not just
  // the first, so a missing secondary folder is still surfaced.
  useEffect(() => {
    if (!isOpen) {
      setMissingDirs([]);
      return;
    }
    const dirs = workingDirs
      .map((directory) => directory?.trim())
      .filter((directory): directory is string => Boolean(directory));
    if (dirs.length === 0) {
      setMissingDirs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resolved = await Promise.all(
          dirs.map((directory) =>
            resolvePath({ parts: [directory] }).then((result) => result.path),
          ),
        );
        const missing = await checkDirectoriesExist(resolved);
        if (cancelled) return;
        // Report the user's original folder strings rather than the resolved
        // absolute paths, since those are what they recognize.
        setMissingDirs(
          dirs.filter((_, index) => missing.includes(resolved[index])),
        );
      } catch {
        if (!cancelled) setMissingDirs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, workingDirs]);

  const loadProjectWorkspaceGitStates = useCallback(async () => {
    const missingWorkspaces = projectWorkspaces.filter((workspace) => {
      const key = normalizeComparableWorkspacePath(workspace.path);
      return !projectWorkspaceGitStates[key];
    });
    if (missingWorkspaces.length === 0) {
      return;
    }

    const results = await Promise.all(
      missingWorkspaces.map(async (workspace) => {
        try {
          const resolved = await resolvePath({ parts: [workspace.path] });
          const gitState = await getGitState(resolved.path);
          return {
            key: normalizeComparableWorkspacePath(workspace.path),
            workspaceId: workspace.id,
            classification: classifyWorkspaceAttachment(
              resolved.path,
              gitState,
            ),
            gitState,
          };
        } catch {
          return null;
        }
      }),
    );

    const nextGitStates: Record<string, GitState> = {};
    const nextConfirmedNonGitIds = new Set<string>();
    for (const result of results) {
      if (result) {
        nextGitStates[result.key] = result.gitState;
        if (!result.gitState.isGitRepo) {
          nextConfirmedNonGitIds.add(result.workspaceId);
        }
      }
    }
    if (Object.keys(nextGitStates).length === 0) {
      return;
    }

    setProjectWorkspaceGitStates((current) => ({
      ...current,
      ...nextGitStates,
    }));
    setConfirmedNonGitWorkspaceIds((current) => {
      const next = new Set(current);
      for (const workspaceId of nextConfirmedNonGitIds) next.add(workspaceId);
      return next;
    });
    setProjectWorkspaces((current) =>
      current.map((workspace) => {
        const result = results.find(
          (candidate) => candidate?.workspaceId === workspace.id,
        );
        if (!result) return workspace;
        return {
          ...workspace,
          ...result.classification,
          path: workspace.path,
          startupMode: workspace.startupMode,
        };
      }),
    );
  }, [projectWorkspaceGitStates, projectWorkspaces]);

  useEffect(() => {
    if (!isOpen || !isMultiWorkspaceMode) {
      return;
    }
    void loadProjectWorkspaceGitStates();
  }, [isMultiWorkspaceMode, isOpen, loadProjectWorkspaceGitStates]);

  const handleChooseCustomIcon = async () => {
    await chooseCustomIcon({
      title: t("dialog.customIconDialogTitle"),
      filterName: t("dialog.iconFileFilter"),
    });
  };

  const handleAddDirectory = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("dialog.addDirectoryDialogTitle"),
      });
      if (selected && typeof selected === "string") {
        setWorkingDir(selected);
        setProjectWorkspaces(
          workspaceRepository.projectWorkspaces({
            projectWorkspaces: [],
            workingDirs: [selected],
            useWorktrees: false,
          }).workspaces,
        );
      }
    } catch {
      // Dialog plugin not available
    }
  };

  // Pre-fill fields when the dialog opens or when the project identity changes,
  // but NOT on every parent re-render (which would reset user edits mid-typing).
  const [previousOpen, setPreviousOpen] = useState(false);
  const [previousEditingId, setPreviousEditingId] = useState<
    string | undefined
  >(undefined);
  const justOpened = isOpen && !previousOpen;
  const projectIdChanged =
    isOpen && !justOpened && editingProject?.id !== previousEditingId;
  if (previousOpen !== isOpen || previousEditingId !== editingProject?.id) {
    setPreviousOpen(isOpen);
    setPreviousEditingId(editingProject?.id);
  }

  if (justOpened || projectIdChanged) {
    if (editingProject) {
      const projectWorkspaceSet =
        workspaceRepository.projectWorkspaces(editingProject);
      setName(editingProject.name);
      setPrompt(editingProject.prompt);
      setProjectWorkspaces(projectWorkspaceSet.workspaces);
      setWorkingDir(
        projectWorkspaceSet.primary?.path ??
          editingProject.workingDirs[0] ??
          "",
      );
      resetIcon(editingProject.icon || DEFAULT_PROJECT_ICON);
      setColor(editingProject.color || DEFAULT_PROJECT_COLOR);
      setError(null);
    } else {
      const seedDir = initialWorkingDir?.trim() ?? "";
      setName(getDefaultProjectName(initialWorkingDir));
      setPrompt("");
      setProjectWorkspaces(
        workspaceRepository.projectWorkspaces({
          projectWorkspaces: [],
          workingDirs: seedDir ? [seedDir] : [],
          useWorktrees: false,
        }).workspaces,
      );
      setWorkingDir(seedDir);
      resetIcon(DEFAULT_PROJECT_ICON);
      setColor(DEFAULT_PROJECT_COLOR);
      setError(null);
    }
  }

  const canSave = name.trim().length > 0 && !saving;

  const handleClose = () => {
    setName("");
    setPrompt("");
    setProjectWorkspaces([]);
    setWorkingDir("");
    setProjectWorkspaceGitStates({});
    setConfirmedNonGitWorkspaceIds(new Set());
    setPendingWorktreePolicyWorkspaceId(null);
    resetIcon(DEFAULT_PROJECT_ICON);
    setColor(DEFAULT_PROJECT_COLOR);
    setError(null);
    onClose();
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    // Preserve typed include-directives for older project prompts, while the
    // workspace list keeps its own workingDirs state in the redesigned form.
    const { prompt: parsedPrompt, workingDirs: parsedWorkingDirs } =
      parseEditorText(prompt);
    const trimmedWorkingDir = workingDir.trim();
    const originalWorkingDir = editingProject?.workingDirs[0]?.trim() ?? "";
    const singleModeWorkingDirChanged = isEditing
      ? trimmedWorkingDir || originalWorkingDir
        ? !isSameWorkspacePath(trimmedWorkingDir, originalWorkingDir)
        : false
      : true;
    const singleModeProjectWorkspaces =
      isEditing && !singleModeWorkingDirChanged
        ? normalizeProjectWorkspaces(
            editingProject.projectWorkspaces,
            editingProject.workingDirs,
            editingProject.useWorktrees,
          )
        : normalizeProjectWorkspaces(
            undefined,
            trimmedWorkingDir ? [trimmedWorkingDir] : [],
            false,
          );
    const savedProjectWorkspaces = isMultiWorkspaceMode
      ? [...enrichedProjectWorkspaces]
      : singleModeProjectWorkspaces;
    for (const directory of parsedWorkingDirs) {
      if (
        !savedProjectWorkspaces.some((workspace) =>
          isSameWorkspacePath(workspace.path, directory),
        )
      ) {
        const workspace = projectWorkspaceFromDirectory(directory);
        if (workspace) {
          savedProjectWorkspaces.push(workspace);
        }
      }
    }
    const sanitizedProjectWorkspaces = savedProjectWorkspaces.map(
      (workspace) =>
        confirmedNonGitWorkspaceIds.has(workspace.id)
          ? { ...workspace, startupMode: "none" as const }
          : workspace,
    );
    const savedWorkingDirs = sanitizedProjectWorkspaces.map(
      (workspace) => workspace.path,
    );
    try {
      let savedProject: ProjectInfo;
      if (isEditing) {
        savedProject = await updateProject(editingProject, {
          name: name.trim(),
          description: editingProject.description ?? "",
          prompt: parsedPrompt,
          icon,
          color,
          workingDirs: savedWorkingDirs,
          useWorktrees: editingProject.useWorktrees,
          projectWorkspaces: sanitizedProjectWorkspaces,
        });
        // Completed only after the persist resolves; the returned ProjectInfo is
        // authoritative for has_working_dir / has_prompt.
        trackProjectEditCompleted(savedProject);
      } else {
        savedProject = await createProject(
          name.trim(),
          "",
          parsedPrompt,
          icon,
          color,
          savedWorkingDirs,
          false,
          sanitizedProjectWorkspaces,
        );
        trackProjectCreateCompleted(savedProject);
      }
      onCreated(savedProject);
      onClose();
    } catch (err) {
      setError(formatAcpErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const titleText = isEditing
    ? t("dialog.editTitle")
    : t("dialog.newTitleShort");
  const shouldUseSavedPreviewArtifact =
    editingProject !== undefined && name.trim() === editingProject.name;
  const previewArtifact = shouldUseSavedPreviewArtifact
    ? (editingProject?.artifact ?? null)
    : null;
  const selectedPanelColor =
    pillCssColor(color) ??
    (/^#[0-9a-f]{3,8}$/i.test(color) ? color : null) ??
    pillCssColor(DEFAULT_PROJECT_COLOR) ??
    "#c4e2f6";

  // Keep a stable `input` reference so the hero renderer only reconciles when a
  // field it actually derives from changes. A fresh object literal here would
  // bust the renderer's input-keyed memo on every keystroke and icon change,
  // re-rendering the heavy three.js scene and freezing the dialog.
  const previewInput = useMemo(
    () => ({
      projectId: editingProject?.id ?? null,
      name,
      prompt,
      color,
      workingDirs,
      artifact: previewArtifact,
    }),
    [editingProject?.id, name, prompt, color, workingDirs, previewArtifact],
  );

  const folderDisplay = workingDir
    ? workingDir.split(/[\\/]/).filter(Boolean).pop()
    : null;

  const enrichedProjectWorkspaces = useMemo<ProjectWorkspace[]>(
    () =>
      projectWorkspaces.map((workspace) => {
        const gitState =
          projectWorkspaceGitStates[
            normalizeComparableWorkspacePath(workspace.path)
          ];
        const enriched = enrichWorkspaceAttachmentWithGitState(
          workspace,
          gitState,
        );
        return {
          ...workspace,
          ...enriched,
          startupMode: workspace.startupMode,
        };
      }),
    [projectWorkspaceGitStates, projectWorkspaces],
  );

  const applyWorkspaceStartupModeChange = (
    workspaceId: string,
    startupMode: ProjectWorkspaceStartupMode,
  ) => {
    const targetWorkspace = enrichedProjectWorkspaces.find(
      (workspace) => workspace.id === workspaceId,
    );
    const targetSyncKey = targetWorkspace
      ? startupPolicySyncKey(targetWorkspace, startupMode)
      : null;

    setProjectWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id === workspaceId) {
          return { ...workspace, startupMode };
        }

        if (!targetSyncKey || startupMode === "none") {
          return workspace;
        }

        const enrichedWorkspace =
          enrichedProjectWorkspaces.find(
            (candidate) => candidate.id === workspace.id,
          ) ?? workspace;
        if (
          startupPolicySyncKey(enrichedWorkspace, startupMode) ===
            targetSyncKey &&
          startupModeAllowedForWorkspace(enrichedWorkspace, startupMode)
        ) {
          return { ...workspace, startupMode };
        }

        return workspace;
      }),
    );
  };

  const includeWorkspaceCandidate = useCallback(
    (
      candidate: WorkspaceAddCandidate,
      editedWorkspaceId: string | null = null,
    ) => {
      const workspace = projectWorkspaceFromCandidate(
        candidate,
        enrichedProjectWorkspaces,
      );
      const contextWorkspaces = editedWorkspaceId
        ? enrichedProjectWorkspaces.filter(
            (current) => current.id !== editedWorkspaceId,
          )
        : enrichedProjectWorkspaces;
      const sameRepoStartupMode = nonNoneStartupModeFromProjectWorkspaceContext(
        candidate,
        contextWorkspaces,
      );
      const editedWorkspace = editedWorkspaceId
        ? (enrichedProjectWorkspaces.find(
            (current) => current.id === editedWorkspaceId,
          ) ??
          projectWorkspaces.find((current) => current.id === editedWorkspaceId))
        : null;
      const canPreserveEditedStartupMode =
        editedWorkspace &&
        startupModeAllowedForWorkspace(
          workspace,
          editedWorkspace.startupMode,
        ) &&
        (editedWorkspace.startupMode === "none" ||
          workspaceStartupModeAppliesToCandidate(candidate, editedWorkspace));
      const nextWorkspace =
        sameRepoStartupMode &&
        startupModeAllowedForWorkspace(workspace, sameRepoStartupMode)
          ? { ...workspace, startupMode: sameRepoStartupMode }
          : canPreserveEditedStartupMode
            ? { ...workspace, startupMode: editedWorkspace.startupMode }
            : workspace;

      setProjectWorkspaces((current) => {
        const editedIndex = editedWorkspaceId
          ? current.findIndex((existing) => existing.id === editedWorkspaceId)
          : -1;
        const existingPathIndex = current.findIndex(
          (existing) =>
            (!editedWorkspaceId || existing.id !== editedWorkspaceId) &&
            isSameWorkspacePath(existing.path, nextWorkspace.path),
        );
        const insertionIndex =
          editedIndex >= 0
            ? editedIndex
            : existingPathIndex >= 0
              ? existingPathIndex
              : current.length;
        const shouldRemoveWorkspace = (existing: ProjectWorkspace) =>
          existing.id === editedWorkspaceId ||
          isSameWorkspacePath(existing.path, nextWorkspace.path);
        const priorRemovedCount = current
          .slice(0, insertionIndex)
          .filter(shouldRemoveWorkspace).length;
        const nextIndex = Math.max(0, insertionIndex - priorRemovedCount);
        const remaining = current.filter(
          (existing) => !shouldRemoveWorkspace(existing),
        );
        return [
          ...remaining.slice(0, nextIndex),
          nextWorkspace,
          ...remaining.slice(nextIndex),
        ];
      });
    },
    [enrichedProjectWorkspaces, projectWorkspaces],
  );

  const pendingWorktreePolicyWorkspace = useMemo(
    () =>
      enrichedProjectWorkspaces.find(
        (workspace) => workspace.id === pendingWorktreePolicyWorkspaceId,
      ) ?? null,
    [enrichedProjectWorkspaces, pendingWorktreePolicyWorkspaceId],
  );

  const handleWorkspaceStartupModeChange = (
    workspaceId: string,
    startupMode: ProjectWorkspaceStartupMode,
  ) => {
    const workspace = enrichedProjectWorkspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace || !startupModeAllowedForWorkspace(workspace, startupMode)) {
      return;
    }

    if (
      isWorktreeStartupMode(startupMode) &&
      !isWorktreeStartupMode(workspace.startupMode) &&
      workspaceUsesLinkedWorktree(workspace)
    ) {
      setPendingWorktreePolicyWorkspaceId(workspace.id);
      return;
    }

    applyWorkspaceStartupModeChange(workspace.id, startupMode);
  };

  const chooseProjectWorkspaceFolder = useCallback(
    async ({
      defaultPath,
      editedWorkspaceId = null,
    }: {
      defaultPath?: string | null;
      editedWorkspaceId?: string | null;
    }) => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: defaultPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("dialog.addDirectoryDialogTitle"),
      });
      if (typeof selected !== "string") {
        return;
      }

      await ensureDirectory(selected);
      const gitState = await getGitState(selected);
      const candidate = workspaceAddCandidateFromDirectory(selected, gitState);
      setProjectWorkspaceGitStates((current) => ({
        ...current,
        [normalizeComparableWorkspacePath(selected)]: gitState,
      }));
      includeWorkspaceCandidate(candidate, editedWorkspaceId);
    },
    [includeWorkspaceCandidate, t],
  );

  const handleOpenAddWorkspace = useCallback(() => {
    setIsPreparingAddWorkspace(true);
    void chooseProjectWorkspaceFolder({ defaultPath: workingDirs[0] })
      .catch((error) => {
        console.warn("Failed to choose project folder:", error);
      })
      .finally(() => {
        setIsPreparingAddWorkspace(false);
      });
  }, [chooseProjectWorkspaceFolder, workingDirs]);

  const handleOpenEditWorkspace = (workspace: ProjectWorkspace) => {
    setIsPreparingAddWorkspace(true);
    void chooseProjectWorkspaceFolder({
      defaultPath: workspace.path,
      editedWorkspaceId: workspace.id,
    })
      .catch((error) => {
        console.warn("Failed to choose project folder:", error);
      })
      .finally(() => {
        setIsPreparingAddWorkspace(false);
      });
  };

  const handleRemoveWorkspace = (workspaceId: string) => {
    setProjectWorkspaces((current) =>
      current.filter((workspace) => workspace.id !== workspaceId),
    );
  };
  const projectWorkspaceAddTrigger = (
    <WorkspaceAddTrigger
      label={t(
        projectWorkspaces.length > 0
          ? "dialog.addAnotherFolder"
          : "dialog.addFolder",
      )}
      onClick={handleOpenAddWorkspace}
      loading={isPreparingAddWorkspace}
      className={cn(
        "min-h-8 w-auto max-w-full gap-2 rounded-[14px] border-0 bg-card/85 px-3 py-1.5 text-[14px] leading-[18px] text-card-foreground shadow-none outline-none transition-[box-shadow,background-color] duration-200",
        "hover:bg-card hover:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus:bg-card focus:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.18)]",
        "disabled:cursor-wait disabled:opacity-70 disabled:hover:bg-card",
      )}
      iconClassName="size-3.5 text-card-foreground"
      labelClassName="flex-none text-card-foreground"
    />
  );

  return (
    <>
      <Sheet
        open={isOpen}
        modal={modal}
        onOpenChange={(open) => !open && handleClose()}
      >
        <SheetContent
          className="top-3 right-3 bottom-3 h-auto w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-[24px] p-0 shadow-[0_22px_72px_rgba(15,23,42,0.18)] backdrop-blur-2xl transition-colors duration-500 ease-out data-[state=open]:duration-500 data-[state=open]:ease-[cubic-bezier(0.19,1,0.22,1)] data-[state=closed]:duration-300 data-[state=closed]:ease-[cubic-bezier(0.215,0.61,0.355,1)] sm:top-5 sm:right-5 sm:bottom-5 sm:w-[560px] sm:max-w-none"
          closeButtonClassName="top-5 right-5 rounded-sm bg-transparent opacity-80 hover:bg-card/50"
          overlayClassName="bg-transparent"
          style={{
            // Two deliberate knobs, both theme-aware tokens: the inner mix
            // forms an opaque panel hue (--project-panel-tint share of the
            // project color over the theme background) so label contrast no
            // longer depends on what sits behind the sheet; the outer mix
            // applies --project-panel-alpha so the backdrop blur keeps a
            // controlled amount of glassiness.
            backgroundColor: `color-mix(in oklab, color-mix(in oklab, ${selectedPanelColor} var(--project-panel-tint), var(--background)) var(--project-panel-alpha), transparent)`,
          }}
          aria-describedby={undefined}
          onPointerDownOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[data-starter-task-list="true"]')
            ) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[data-starter-task-list="true"]')
            ) {
              event.preventDefault();
            }
          }}
        >
          <form
            id="project-form"
            onSubmit={handleSave}
            className="flex h-full min-h-0 flex-col"
          >
            {/* Header: title at top-left. Sheet renders its own close X. */}
            <div className="flex items-center gap-2 px-8 pt-5 pb-2">
              <SheetTitle className="truncate text-sm font-normal text-foreground">
                {titleText}
              </SheetTitle>
            </div>

            {/* Scrollable form body. The hero (cube + color picker) scrolls
                with the form so the swatch pill's shadow is never clipped by a
                fixed hero container and the area below scrolls naturally. */}
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-transparent px-6 pt-0 pb-5 sm:px-8">
              {/* Hero stays transparent so the glass panel reveals whatever
                  sits underneath instead of painting a fake backdrop. */}
              <div className="relative h-[300px] pb-4">
                <ProjectArtifactPreview
                  input={previewInput}
                  className="h-full w-full"
                />
                <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">
                  <ProjectColorPicker
                    value={color}
                    onChange={setColor}
                    variant="swatches"
                  />
                </div>
              </div>

              <ProjectIconPicker
                icon={icon}
                color={color}
                iconCandidates={iconCandidates}
                error={iconError}
                onChooseIcon={chooseIcon}
                onChooseCustomIcon={handleChooseCustomIcon}
              />

              <div className="group/field space-y-2">
                <Label className={panelLabelClass}>
                  {t("dialog.nameLabel")}{" "}
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  placeholder={t("dialog.nameInlinePlaceholder")}
                  className={cn(panelFieldClass, "h-[42px] px-3.5 py-0")}
                />
              </div>

              {!isMultiWorkspaceMode ? (
                <div className="group/field space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label className={panelLabelClass}>
                      {t("dialog.folderLabel")}
                    </Label>
                    {missingDirs.length > 0 ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-destructive"
                            aria-label={t("dialog.invalidFolderTooltip", {
                              count: missingDirs.length,
                            })}
                          >
                            <IconAlertTriangle
                              className="size-3.5 text-destructive"
                              aria-hidden="true"
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[260px]">
                          <p>
                            {t("dialog.invalidFolderTooltip", {
                              count: missingDirs.length,
                            })}
                          </p>
                          <ul className="mt-1 list-disc pl-4">
                            {missingDirs.map((directory) => (
                              <li key={directory} className="break-all">
                                {directory}
                              </li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={handleAddDirectory}
                    className={cn(
                      panelFieldClass,
                      "flex h-[42px] w-full items-center gap-2.5 pr-3.5 pl-[17px] text-left",
                    )}
                  >
                    <IconFolderPlus
                      className="size-3 text-card-foreground"
                      aria-hidden="true"
                    />
                    <span
                      className={
                        folderDisplay
                          ? "truncate text-card-foreground"
                          : "truncate text-card-foreground/30"
                      }
                    >
                      {folderDisplay ?? t("dialog.folderPlaceholder")}
                    </span>
                  </button>
                </div>
              ) : (
                <div className="group/field space-y-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Label className={panelLabelClass}>
                      {t("dialog.workspacesLabel")}
                    </Label>
                    {missingDirs.length > 0 ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-destructive"
                            aria-label={t("dialog.invalidFolderTooltip", {
                              count: missingDirs.length,
                            })}
                          >
                            <IconAlertTriangle
                              className="size-3.5 text-destructive"
                              aria-hidden="true"
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[260px]">
                          <p>
                            {t("dialog.invalidFolderTooltip", {
                              count: missingDirs.length,
                            })}
                          </p>
                          <ul className="mt-1 list-disc pl-4">
                            {missingDirs.map((directory) => (
                              <li key={directory} className="break-all">
                                {directory}
                              </li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    {enrichedProjectWorkspaces.length > 0 ? (
                      <div className="overflow-hidden rounded-sm bg-card text-card-foreground">
                        {enrichedProjectWorkspaces.map((workspace, index) => {
                          const startupModeOptions =
                            startupModeOptionsForWorkspace();
                          const workspaceGitState =
                            projectWorkspaceGitStates[
                              normalizeComparableWorkspacePath(workspace.path)
                            ];
                          const canConfigureWorktrees =
                            hasGitWorkspaceKind(workspace) ||
                            Boolean(workspace.repositoryPath) ||
                            (!confirmedNonGitWorkspaceIds.has(workspace.id) &&
                              workspace.startupMode !== "none");
                          return (
                            <div
                              key={workspace.id}
                              className={cn(
                                "flex min-w-0 items-start gap-3 px-4 py-3",
                                index > 0 &&
                                  "border-t border-card-foreground/10",
                              )}
                            >
                              <div
                                className={cn(
                                  "min-w-0 flex-1 space-y-2",
                                  !canConfigureWorktrees && "self-center",
                                )}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleOpenEditWorkspace(workspace)
                                  }
                                  aria-label={t("dialog.editWorkspace", {
                                    name: getWorkspaceDisplayName(
                                      workspace.path,
                                    ),
                                  })}
                                  className="block w-full rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-card-foreground/30"
                                >
                                  <WorkspaceIdentity
                                    workspace={workspace}
                                    gitState={workspaceGitState}
                                    className="min-w-0"
                                    iconKind={
                                      canConfigureWorktrees
                                        ? "repository"
                                        : "folder"
                                    }
                                    showMetadata={false}
                                    showHoverChevron={false}
                                    iconTooltip={t(
                                      canConfigureWorktrees
                                        ? "dialog.workspacePolicy.gitFolderTooltip"
                                        : "dialog.workspacePolicy.regularFolderTooltip",
                                    )}
                                    iconClassName="text-card-foreground"
                                    titleClassName="text-card-foreground"
                                  />
                                </button>
                                {canConfigureWorktrees ? (
                                  <div className="mt-1 max-w-[260px] pl-[22px]">
                                    <Select
                                      value={
                                        configuredWorktreeStartupMode(
                                          workspace.startupMode,
                                        ) ?? "none"
                                      }
                                      onValueChange={(value) =>
                                        handleWorkspaceStartupModeChange(
                                          workspace.id,
                                          value as ProjectWorkspaceStartupMode,
                                        )
                                      }
                                    >
                                      <SelectTrigger
                                        aria-label={t(
                                          "dialog.workspacePolicy.label",
                                          {
                                            name: getWorkspaceDisplayName(
                                              workspace.path,
                                            ),
                                          },
                                        )}
                                        className={cn(
                                          "relative h-8 w-full rounded-sm border border-card-foreground/10 bg-muted px-3 text-sm shadow-none hover:bg-accent-hover focus-visible:ring-0",
                                          configuredWorktreeStartupMode(
                                            workspace.startupMode,
                                          ) === null &&
                                            "text-card-foreground/40",
                                        )}
                                      >
                                        <SelectValue
                                          placeholder={t(
                                            "dialog.workspacePolicy.placeholder",
                                          )}
                                        />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem
                                          value="none"
                                          className="hidden"
                                        >
                                          {t(
                                            "dialog.workspacePolicy.placeholder",
                                          )}
                                        </SelectItem>
                                        {startupModeOptions.map((mode) => (
                                          <SelectItem key={mode} value={mode}>
                                            {projectWorkspaceStartupModeLabel(
                                              mode,
                                              t,
                                            )}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                ) : null}
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                destructive
                                size="icon-xs"
                                onClick={() =>
                                  handleRemoveWorkspace(workspace.id)
                                }
                                aria-label={t("dialog.removeWorkspace", {
                                  name: getWorkspaceDisplayName(workspace.path),
                                })}
                                className={cn(
                                  "shrink-0",
                                  canConfigureWorktrees
                                    ? "mt-0.5"
                                    : "self-center",
                                )}
                              >
                                <IconTrash className="size-4" />
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="flex">{projectWorkspaceAddTrigger}</div>
                  </div>
                </div>
              )}

              <div className="group/field space-y-2">
                <Label className={panelLabelClass}>
                  {t("dialog.describeLabel")}
                </Label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("dialog.describePlaceholder")}
                  rows={4}
                  className={cn(
                    panelFieldClass,
                    "h-[215px] min-h-[215px] w-full resize-none px-3.5 py-[13px]",
                  )}
                />
              </div>

              {error ? (
                <p className="text-xs text-destructive">{error}</p>
              ) : null}
            </div>

            {/* Footer: Cancel (left) + Save/Create (right). */}
            <div className="flex shrink-0 items-center justify-end gap-3 bg-transparent px-6 pt-2 pb-7 sm:px-8">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClose}
                disabled={saving}
                className="h-10 rounded-sm px-4 text-sm"
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                form="project-form"
                variant="primary"
                size="sm"
                disabled={!canSave}
                className="h-10 rounded-sm px-5 text-sm"
              >
                {saving
                  ? isEditing
                    ? t("dialog.saving")
                    : t("dialog.creating")
                  : isEditing
                    ? t("common:actions.saveChanges")
                    : t("dialog.createProject")}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={Boolean(pendingWorktreePolicyWorkspace)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingWorktreePolicyWorkspaceId(null);
          }
        }}
        title={t("dialog.workspacePolicy.worktreeFromWorktreeConfirmTitle")}
        description={t(
          "dialog.workspacePolicy.worktreeFromWorktreeConfirmDescription",
          {
            name: pendingWorktreePolicyWorkspace
              ? getWorkspaceDisplayName(pendingWorktreePolicyWorkspace.path)
              : "",
          },
        )}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("dialog.workspacePolicy.createWorktree")}
        destructive={false}
        contentClassName="max-w-[420px]"
        onConfirm={() => {
          if (pendingWorktreePolicyWorkspace) {
            applyWorkspaceStartupModeChange(
              pendingWorktreePolicyWorkspace.id,
              "worktree",
            );
          }
          setPendingWorktreePolicyWorkspaceId(null);
        }}
      />
    </>
  );
}
