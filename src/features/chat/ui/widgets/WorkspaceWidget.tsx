import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  RefreshCw,
  Replace,
} from "lucide-react";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { CreatedWorktree, GitState } from "@/shared/types/git";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Spinner } from "@/shared/ui/spinner";
import { shortenPath } from "./workspacePath";
import type { WorkspaceGitRuntime } from "../hooks/useWorkspaceGitRuntimes";
import { WorkspaceAddTrigger } from "./WorkspaceAddDialog";
import { WorkspaceIdentity } from "./WorkspaceIdentity";
import { WorkspaceContextPicker } from "./WorkspaceContextPicker";
import {
  WorkspaceRowActionsMenu,
  type WorkspaceRemovalPlan,
} from "./WorkspaceRowActionsMenu";
import type { CreatedWorkspaceWorktreeContext } from "./WorkspaceCreateDialog";

interface WorkspaceWidgetProps {
  projectId?: string;
  projectName?: string;
  projectIcon?: string;
  projectColor?: string;
  projectWorkingDirs: string[];
  sessionWorkingDir?: string | null;
  primaryWorkspaceRoot: string | null;
  fallbackGitState: GitState | undefined;
  fallbackIsLoading: boolean;
  fallbackIsFetching: boolean;
  fallbackError: Error | null;
  workspaceRuntimes?: WorkspaceGitRuntime[];
  isProjectContext?: boolean;
  onInitRepo: (path: string) => Promise<void>;
  onFetch: (path: string) => Promise<void>;
  onPull: (path: string) => Promise<void>;
  onChangeFolder?: () => Promise<void> | void;
  onCreateBranch: (
    runtime: WorkspaceGitRuntime,
    path: string,
    name: string,
    baseBranch: string,
  ) => Promise<void>;
  onCreateWorktree: (
    path: string,
    name: string,
    branch: string,
    createBranch: boolean,
    baseBranch?: string,
  ) => Promise<CreatedWorktree>;
  onWorktreeCreated: (
    runtime: WorkspaceGitRuntime,
    worktree: CreatedWorktree,
    context: CreatedWorkspaceWorktreeContext,
  ) => void;
  onSelectWorktree: (
    runtime: WorkspaceGitRuntime,
    path: string,
    branch: string | null,
  ) => void;
  onSwitchBranch: (
    runtime: WorkspaceGitRuntime,
    path: string,
    branch: string,
  ) => Promise<void>;
  onStashAndSwitch: (
    runtime: WorkspaceGitRuntime,
    path: string,
    branch: string,
  ) => Promise<void>;
  onAddWorkspace?: () => Promise<void> | void;
  onRemoveWorkspace?: (
    workspace: WorkspaceAttachment,
    removalPlan: WorkspaceRemovalPlan,
  ) => Promise<void> | void;
  getRemovalPlan?: (workspace: WorkspaceAttachment) => WorkspaceRemovalPlan;
  onOpenTerminalAtPath?: (path: string) => void;
  isChangingFolder?: boolean;
}

function WorkspaceRow({
  runtime,
  onInitRepo,
  onFetch,
  onPull,
  onCreateBranch,
  onCreateWorktree,
  onWorktreeCreated,
  onSelectWorktree,
  onSwitchBranch,
  onStashAndSwitch,
  onRemoveWorkspace,
  getRemovalPlan,
  onOpenTerminalAtPath,
  expanded,
  collapsible,
  onToggleExpanded,
}: {
  runtime: WorkspaceGitRuntime;
  onInitRepo: (path: string) => Promise<void>;
  onFetch: (path: string) => Promise<void>;
  onPull: (path: string) => Promise<void>;
  onCreateBranch: (
    runtime: WorkspaceGitRuntime,
    path: string,
    name: string,
    baseBranch: string,
  ) => Promise<void>;
  onCreateWorktree: (
    path: string,
    name: string,
    branch: string,
    createBranch: boolean,
    baseBranch?: string,
  ) => Promise<CreatedWorktree>;
  onWorktreeCreated: (
    runtime: WorkspaceGitRuntime,
    worktree: CreatedWorktree,
    context: CreatedWorkspaceWorktreeContext,
  ) => void;
  onSelectWorktree: (
    runtime: WorkspaceGitRuntime,
    path: string,
    branch: string | null,
  ) => void;
  onSwitchBranch: (
    runtime: WorkspaceGitRuntime,
    path: string,
    branch: string,
  ) => Promise<void>;
  onStashAndSwitch: (
    runtime: WorkspaceGitRuntime,
    path: string,
    branch: string,
  ) => Promise<void>;
  onRemoveWorkspace?: (
    workspace: WorkspaceAttachment,
    removalPlan: WorkspaceRemovalPlan,
  ) => Promise<void> | void;
  getRemovalPlan?: (workspace: WorkspaceAttachment) => WorkspaceRemovalPlan;
  onOpenTerminalAtPath?: (path: string) => void;
  expanded: boolean;
  collapsible: boolean;
  onToggleExpanded: () => void;
}) {
  const { t } = useTranslation("chat");
  const { workspace, gitContext, gitState } = runtime;
  const disabled = runtime.isFetching;
  const canInitRepo = gitState?.isGitRepo === false;
  const sharedMenuProps = {
    workspace,
    workspaceName: gitContext.workspaceTitle,
    gitState,
    currentPath: gitContext.actionPath,
    activeBranch: gitContext.branch,
    canUseGitActions: gitContext.canUseGitActions,
    canCreateWorktree: gitContext.canCreateWorktree,
    canInitRepo,
    disabled,
    onInitRepo,
    onFetch,
    onPull,
    onCreateBranch: (path: string, name: string, baseBranch: string) =>
      onCreateBranch(runtime, path, name, baseBranch),
    onCreateWorktree,
    onWorktreeCreated: (
      worktree: CreatedWorktree,
      context: CreatedWorkspaceWorktreeContext,
    ) => onWorktreeCreated(runtime, worktree, context),
    removalPlan: getRemovalPlan?.(workspace),
    onRemoveWorkspace,
    onOpenTerminalAtPath,
  };

  const canShowPickers = Boolean(gitState?.isGitRepo);
  const header = (
    <WorkspaceIdentity
      workspace={workspace}
      gitState={gitState}
      gitContext={gitContext}
      className="min-w-0 flex-1"
      iconClassName="mt-px size-3.5"
      titleClassName="leading-[18px]"
      metadataClassName="mt-1 text-sm leading-[18px] text-muted-foreground"
    />
  );

  const expansionLabel = collapsible
    ? t(
        expanded
          ? "contextPanel.actions.collapseWorkspaceContextFor"
          : "contextPanel.actions.expandWorkspaceContextFor",
        { name: gitContext.workspaceTitle },
      )
    : undefined;

  return (
    <div
      className={cn(
        "group/workspace-row relative w-full min-w-0 rounded-[10px] bg-sidebar-accent px-3 py-2",
        "transition-colors duration-150 focus-within:bg-sidebar-accent/90",
        collapsible && "hover:bg-sidebar-accent/90",
      )}
    >
      {collapsible ? (
        <button
          type="button"
          className="absolute inset-0 z-0 cursor-pointer rounded-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-label={expansionLabel}
          onClick={onToggleExpanded}
        />
      ) : null}
      <div className="pointer-events-none relative z-[1] flex min-w-0 items-start gap-2">
        {header}
        <div className="-mr-1 flex shrink-0 items-center gap-1">
          {runtime.isFetching ? (
            <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          {collapsible ? (
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          ) : null}
          <div className="pointer-events-auto">
            <WorkspaceRowActionsMenu {...sharedMenuProps} />
          </div>
        </div>
      </div>
      {expanded && canShowPickers ? (
        <div className="relative z-[1] mt-3">
          <WorkspaceContextPicker
            gitState={gitState as GitState}
            currentPath={gitContext.actionPath}
            activeBranch={gitContext.branch}
            disabled={disabled}
            onSelectWorktree={(path, branch) =>
              onSelectWorktree(runtime, path, branch)
            }
            onSwitchBranch={(path, branch) =>
              onSwitchBranch(runtime, path, branch)
            }
            onStashAndSwitch={(path, branch) =>
              onStashAndSwitch(runtime, path, branch)
            }
            canCreateWorktree={gitContext.canCreateWorktree}
            onCreateBranch={(path, name, baseBranch) =>
              onCreateBranch(runtime, path, name, baseBranch)
            }
            onCreateWorktree={onCreateWorktree}
            onWorktreeCreated={(worktree, context) =>
              onWorktreeCreated(runtime, worktree, context)
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function AddWorkspaceRow({
  disabled,
  onAddWorkspace,
}: {
  disabled: boolean;
  onAddWorkspace?: () => Promise<void> | void;
}) {
  const { t } = useTranslation("chat");

  return (
    <WorkspaceAddTrigger
      label={t("contextPanel.includedWorkspaces.addWorkspaceAction")}
      onClick={() => void onAddWorkspace?.()}
      disabled={disabled}
      className={cn(
        "gap-2 bg-transparent px-2 py-1 leading-[15px] text-foreground duration-150",
        "hover:bg-sidebar-accent hover:text-foreground focus-visible:bg-sidebar-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-foreground",
      )}
      iconClassName="size-3.5 text-current"
      labelClassName="text-current"
    />
  );
}

function WorkspaceSectionActionsMenu({
  disabled,
  onAddWorkspace,
}: {
  disabled: boolean;
  onAddWorkspace?: () => Promise<void> | void;
}) {
  const { t } = useTranslation("chat");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          className="size-6 rounded-sm"
          aria-label={t("contextPanel.actions.openWorkspaceActionsFor", {
            name: t("contextPanel.labels.workspace"),
          })}
          title={t("contextPanel.actions.openWorkspaceActionsFor", {
            name: t("contextPanel.labels.workspace"),
          })}
        >
          <Ellipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="chat-context-dropdown-surface w-56 rounded-sm px-1 pb-[6px] pt-1"
      >
        <DropdownMenuItem
          disabled={!onAddWorkspace}
          onSelect={() => void onAddWorkspace?.()}
        >
          <FolderPlus className="size-4" />
          {t("contextPanel.includedWorkspaces.addWorkspaceAction")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceWidget({
  projectName,
  projectColor,
  projectWorkingDirs,
  sessionWorkingDir,
  primaryWorkspaceRoot,
  fallbackGitState,
  fallbackIsLoading,
  fallbackIsFetching,
  fallbackError,
  workspaceRuntimes = [],
  isProjectContext = false,
  onInitRepo,
  onFetch,
  onPull,
  onChangeFolder,
  onCreateBranch,
  onCreateWorktree,
  onWorktreeCreated,
  onSelectWorktree,
  onSwitchBranch,
  onStashAndSwitch,
  onAddWorkspace,
  onRemoveWorkspace,
  getRemovalPlan,
  onOpenTerminalAtPath,
  isChangingFolder = false,
}: WorkspaceWidgetProps) {
  const { t } = useTranslation("chat");
  const orderedWorkspaces = workspaceRuntimes;
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const singleWorkspaceId =
    orderedWorkspaces.length === 1 ? orderedWorkspaces[0]?.workspace.id : null;

  useEffect(() => {
    const availableIds = new Set(
      orderedWorkspaces.map((runtime) => runtime.workspace.id),
    );
    setExpandedWorkspaceIds((current) => {
      const next = new Set(
        [...current].filter((workspaceId) => availableIds.has(workspaceId)),
      );
      if (singleWorkspaceId) next.add(singleWorkspaceId);
      if (
        next.size === current.size &&
        [...next].every((workspaceId) => current.has(workspaceId))
      ) {
        return current;
      }
      return next;
    });
  }, [orderedWorkspaces, singleWorkspaceId]);

  const toggleWorkspace = (workspaceId: string) => {
    if (singleWorkspaceId) return;
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };
  const fallbackWorkspaceRoot =
    primaryWorkspaceRoot ??
    projectWorkingDirs[0] ??
    (!projectName ? sessionWorkingDir : null);
  const isArtifactWorkspace = !projectName && projectWorkingDirs.length === 0;
  const projectLabel = projectName
    ? projectName
    : isArtifactWorkspace
      ? t("contextPanel.artifacts.workspaceLabel")
      : t("contextPanel.empty.noProjectAssigned");
  const gitErrorMessage =
    fallbackError instanceof Error
      ? fallbackError.message
      : t("contextPanel.errors.gitRead");
  const hasWorkspaceRows = orderedWorkspaces.length > 0;
  const isRefreshingAnyWorkspace = orderedWorkspaces.some(
    (workspace) => workspace.isFetching,
  );
  const refreshAllWorkspaces = () => {
    void Promise.all(
      orderedWorkspaces.map((workspace) =>
        workspace.refetch().catch(() => undefined),
      ),
    );
  };
  const addWorkspaceRow = (
    <AddWorkspaceRow
      disabled={!onAddWorkspace}
      onAddWorkspace={onAddWorkspace}
    />
  );

  return (
    <section className="w-full px-4 pb-1 pt-4 text-sm font-normal">
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-normal text-muted-foreground">
            {t("contextPanel.labels.project")}
          </p>
          <div className="flex min-w-0 items-center gap-2">
            {projectName ? (
              <span
                className="inline-block size-2 shrink-0 rounded-full bg-success"
                style={
                  projectColor ? { backgroundColor: projectColor } : undefined
                }
              />
            ) : (
              <span
                className="inline-block size-2 shrink-0 rounded-full bg-success"
                style={
                  projectColor ? { backgroundColor: projectColor } : undefined
                }
              />
            )}
            <span className="min-w-0 flex-1 truncate text-foreground">
              {projectLabel}
            </span>
          </div>
        </div>

        <div className="group/workspace-section space-y-1.5">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <p className="text-sm font-normal text-muted-foreground">
              {t("contextPanel.labels.workspace")}
            </p>
            <div
              className={cn(
                "flex shrink-0 items-center gap-1 transition-opacity duration-150",
                !hasWorkspaceRows && "opacity-0",
              )}
            >
              {hasWorkspaceRows ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={refreshAllWorkspaces}
                    disabled={isRefreshingAnyWorkspace}
                    className="size-6 rounded-sm"
                    aria-label={t("contextPanel.actions.refreshLocalStatus")}
                    title={t("contextPanel.actions.refreshLocalStatus")}
                  >
                    {isRefreshingAnyWorkspace ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                  <WorkspaceSectionActionsMenu
                    disabled={!onAddWorkspace}
                    onAddWorkspace={onAddWorkspace}
                  />
                </>
              ) : null}
            </div>
          </div>

          {fallbackIsLoading && fallbackWorkspaceRoot && !fallbackGitState ? (
            <div className="flex items-center gap-2 rounded-sm px-2 py-1 text-foreground">
              <Spinner className="size-3.5" />
              <span>{t("contextPanel.states.gitLoading")}</span>
            </div>
          ) : fallbackError && orderedWorkspaces.length === 0 ? (
            <div className="space-y-1">
              <p className="rounded-sm px-2 py-1 text-destructive">
                {gitErrorMessage}
              </p>
              {addWorkspaceRow}
            </div>
          ) : hasWorkspaceRows ? (
            <div className="space-y-1.5">
              {orderedWorkspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.workspace.id}
                  runtime={workspace}
                  onInitRepo={onInitRepo}
                  onFetch={onFetch}
                  onPull={onPull}
                  onCreateBranch={onCreateBranch}
                  onCreateWorktree={onCreateWorktree}
                  onWorktreeCreated={onWorktreeCreated}
                  onSelectWorktree={onSelectWorktree}
                  onSwitchBranch={onSwitchBranch}
                  onStashAndSwitch={onStashAndSwitch}
                  onRemoveWorkspace={onRemoveWorkspace}
                  getRemovalPlan={getRemovalPlan}
                  onOpenTerminalAtPath={onOpenTerminalAtPath}
                  expanded={
                    singleWorkspaceId === workspace.workspace.id ||
                    expandedWorkspaceIds.has(workspace.workspace.id)
                  }
                  collapsible={!singleWorkspaceId}
                  onToggleExpanded={() =>
                    toggleWorkspace(workspace.workspace.id)
                  }
                />
              ))}
            </div>
          ) : !fallbackWorkspaceRoot || isProjectContext ? (
            <div className="space-y-1">
              {!onAddWorkspace ? (
                <p className="rounded-sm px-2 py-1 text-muted-foreground">
                  {isProjectContext
                    ? t("contextPanel.includedWorkspaces.empty")
                    : t("contextPanel.empty.folderNotSet")}
                </p>
              ) : null}
              {addWorkspaceRow}
            </div>
          ) : !fallbackGitState?.isGitRepo ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void onChangeFolder?.()}
                disabled={
                  !onChangeFolder || isChangingFolder || fallbackIsFetching
                }
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1",
                  "text-sm text-foreground transition-colors",
                  "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-transparent",
                )}
                aria-label={t("contextPanel.folder.change")}
              >
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm leading-[15px] text-foreground">
                    {shortenPath(fallbackWorkspaceRoot)}
                  </span>
                  <span className="block truncate text-xs leading-none text-muted-foreground">
                    {isArtifactWorkspace
                      ? t("contextPanel.artifacts.folderLabel")
                      : t("contextPanel.folder.label")}
                  </span>
                </span>
                {isChangingFolder ? (
                  <Spinner className="size-4 shrink-0" />
                ) : onChangeFolder ? (
                  <Replace className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
              {!isArtifactWorkspace ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void onInitRepo(fallbackWorkspaceRoot)}
                  className="text-sm"
                >
                  <GitBranch className="size-4" />
                  {t("contextPanel.git.initRepo")}
                </Button>
              ) : null}
              {addWorkspaceRow}
            </div>
          ) : (
            addWorkspaceRow
          )}
        </div>
      </div>
    </section>
  );
}
