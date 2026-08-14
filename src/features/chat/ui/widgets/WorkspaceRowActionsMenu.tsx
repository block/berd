import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Download,
  Ellipsis,
  GitBranch,
  GitFork,
  GitPullRequest,
  Terminal,
  Trash2,
} from "lucide-react";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { CreatedWorktree, GitState } from "@/shared/types/git";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { Spinner } from "@/shared/ui/spinner";
import { formatErrorMessage } from "./formatError";
import {
  type CreatedWorkspaceWorktreeContext,
  WorkspaceCreateDialog,
  type WorkspaceCreateMode,
} from "./WorkspaceCreateDialog";

interface WorkspaceRowActionsMenuProps {
  workspace: WorkspaceAttachment;
  workspaceName: string;
  triggerAriaLabel?: string;
  gitState: GitState | undefined;
  currentPath: string;
  activeBranch: string | null;
  canUseGitActions: boolean;
  canCreateWorktree: boolean;
  canInitRepo: boolean;
  removalPlan?: WorkspaceRemovalPlan;
  disabled?: boolean;
  onInitRepo: (path: string) => Promise<void>;
  onFetch: (path: string) => Promise<void>;
  onPull: (path: string) => Promise<void>;
  onCreateBranch: (
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
    worktree: CreatedWorktree,
    context: CreatedWorkspaceWorktreeContext,
  ) => void;
  onRemoveWorkspace?: (
    workspace: WorkspaceAttachment,
    removalPlan: WorkspaceRemovalPlan,
  ) => Promise<void> | void;
  onOpenTerminalAtPath?: (path: string) => void;
}

export interface WorkspaceRemovalPlan {
  cleanup: "none" | "branch" | "worktree";
  isLastUse: boolean;
  usedByAnotherWorkspaceInChat: boolean;
  usedByAnotherChat: boolean;
  branch: string | null;
  baseBranch: string | null;
  repositoryPath: string | null;
  worktreePath: string | null;
  createdBranch: boolean;
}

function getPathBasename(path: string | null | undefined): string | null {
  const trimmedPath = path?.replace(/[\\/]+$/, "");
  if (!trimmedPath) return null;
  const parts = trimmedPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function WorkspaceRowActionsMenu({
  workspace,
  workspaceName,
  triggerAriaLabel,
  gitState,
  currentPath,
  activeBranch,
  canUseGitActions,
  canCreateWorktree,
  canInitRepo,
  removalPlan = {
    cleanup: "none",
    isLastUse: false,
    usedByAnotherWorkspaceInChat: false,
    usedByAnotherChat: false,
    branch: null,
    baseBranch: null,
    repositoryPath: null,
    worktreePath: null,
    createdBranch: false,
  },
  disabled = false,
  onInitRepo,
  onFetch,
  onPull,
  onCreateBranch,
  onCreateWorktree,
  onWorktreeCreated,
  onRemoveWorkspace,
  onOpenTerminalAtPath,
}: WorkspaceRowActionsMenuProps) {
  const { t: tChat } = useTranslation("chat");
  const [dialogMode, setDialogMode] = useState<WorkspaceCreateMode | null>(
    null,
  );
  const [runningAction, setRunningAction] = useState<"fetch" | "pull" | null>(
    null,
  );
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const pullLabel =
    (gitState?.incomingCommitCount ?? 0) > 0
      ? tChat("contextPanel.git.pullCommitCount", {
          count: gitState?.incomingCommitCount ?? 0,
        })
      : tChat("contextPanel.git.pull");

  const menuItemClassName = cn(
    SIDEBAR_ROW_HEIGHT_CLASS,
    SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
    SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
    SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
    SIDEBAR_NAV_TEXT_CLASS,
    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
    // `muted`, not `sidebar-accent`: identical in dark, visible in light.
    "rounded-xs text-foreground hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted",
  );
  const menuLabelClassName =
    "px-3 pb-1 text-sm font-normal text-muted-foreground";
  const triggerAccessibleLabel =
    triggerAriaLabel ??
    tChat("contextPanel.actions.openWorkspaceActionsFor", {
      name: workspaceName,
    });

  const runAction = async (
    action: "fetch" | "pull",
    run: () => Promise<void>,
    successKey: "fetchSuccess" | "pullSuccess",
    errorKey: "fetchError" | "pullError",
  ) => {
    setRunningAction(action);
    try {
      await run();
      toast.success(tChat(`contextPanel.git.${successKey}`));
    } catch (error) {
      toast.error(
        formatErrorMessage(error, tChat(`contextPanel.git.${errorKey}`)),
      );
    } finally {
      setRunningAction(null);
    }
  };

  const dirtyFileCount = gitState?.dirtyFileCount ?? 0;
  const shouldCleanupResource =
    removalPlan.cleanup !== "none" && removalPlan.isLastUse;
  const shouldCleanupWorktree =
    removalPlan.cleanup === "worktree" && removalPlan.isLastUse;
  const cleanupResourceLabel =
    removalPlan.cleanup === "worktree"
      ? tChat("contextPanel.includedWorkspaces.cleanupResource.worktree")
      : tChat("contextPanel.includedWorkspaces.cleanupResource.branch");
  const cleanupWorktreeName =
    getPathBasename(removalPlan.worktreePath) ?? "worktree";
  const removeDialogTitle = shouldCleanupResource
    ? shouldCleanupWorktree
      ? tChat("contextPanel.includedWorkspaces.removeWorktreeConfirmTitle")
      : tChat("contextPanel.includedWorkspaces.removeManagedConfirmTitle", {
          resource: cleanupResourceLabel,
        })
    : tChat("contextPanel.includedWorkspaces.removeConfirmTitle");
  const shouldConfirmRemoval =
    shouldCleanupResource || !removalPlan.usedByAnotherWorkspaceInChat;
  const removeDialogBody = shouldCleanupResource
    ? shouldCleanupWorktree
      ? dirtyFileCount > 0
        ? tChat(
            "contextPanel.includedWorkspaces.removeWorktreeConfirmBodyWithChanges",
            {
              count: dirtyFileCount,
              worktree: cleanupWorktreeName,
            },
          )
        : tChat("contextPanel.includedWorkspaces.removeWorktreeConfirmBody", {
            worktree: cleanupWorktreeName,
          })
      : dirtyFileCount > 0
        ? tChat(
            "contextPanel.includedWorkspaces.removeManagedConfirmBodyWithChanges",
            {
              count: dirtyFileCount,
              resource: cleanupResourceLabel,
            },
          )
        : tChat("contextPanel.includedWorkspaces.removeManagedConfirmBody", {
            resource: cleanupResourceLabel,
          })
    : removalPlan.cleanup !== "none" && !removalPlan.isLastUse
      ? tChat(
          "contextPanel.includedWorkspaces.removeSharedManagedConfirmBodyOtherChat",
          {
            resource: cleanupResourceLabel,
          },
        )
      : dirtyFileCount > 0
        ? tChat(
            "contextPanel.includedWorkspaces.removeConfirmBodyWithChanges",
            { count: dirtyFileCount },
          )
        : tChat("contextPanel.includedWorkspaces.removeConfirmBody");
  const removeDialogAction = shouldCleanupResource
    ? shouldCleanupWorktree
      ? tChat("contextPanel.includedWorkspaces.removeWorktreeConfirmAction")
      : tChat("contextPanel.includedWorkspaces.removeManagedConfirmAction", {
          resource: cleanupResourceLabel,
        })
    : tChat("contextPanel.includedWorkspaces.removeConfirmAction");

  const handleRemoveWorkspace = async () => {
    if (!onRemoveWorkspace) return;
    setIsRemoving(true);
    try {
      await onRemoveWorkspace(workspace, removalPlan);
      setRemoveDialogOpen(false);
    } catch (error) {
      toast.error(
        formatErrorMessage(
          error,
          shouldCleanupResource
            ? tChat("contextPanel.includedWorkspaces.removeManagedError", {
                resource: cleanupResourceLabel,
              })
            : tChat("contextPanel.includedWorkspaces.removeError"),
        ),
      );
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-6 shrink-0 rounded-sm"
            aria-label={triggerAccessibleLabel}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          // Card surface + the rail's rounded-md; rounded-xs items stay
          // concentric inside the px-3 gutter (6px + 12px = 18px).
          className="w-64 rounded-md bg-card px-3 pb-[6px] pt-3"
        >
          {onOpenTerminalAtPath ? (
            <DropdownMenuItem
              className={menuItemClassName}
              onSelect={() => onOpenTerminalAtPath(workspace.path)}
            >
              <Terminal className="size-4" />
              {tChat("terminal.open")}
            </DropdownMenuItem>
          ) : null}
          {canInitRepo ? (
            <DropdownMenuItem
              className={menuItemClassName}
              disabled={disabled || runningAction !== null}
              onSelect={() => void onInitRepo(workspace.path)}
            >
              <GitBranch className="size-4" />
              {tChat("contextPanel.git.initRepo")}
            </DropdownMenuItem>
          ) : null}
          {onRemoveWorkspace ? (
            <DropdownMenuItem
              className={menuItemClassName}
              onSelect={() => {
                if (shouldConfirmRemoval) {
                  setRemoveDialogOpen(true);
                  return;
                }
                void handleRemoveWorkspace();
              }}
            >
              <Trash2 className="size-4" />
              {tChat("contextPanel.includedWorkspaces.remove")}
            </DropdownMenuItem>
          ) : null}

          {canUseGitActions ? (
            <>
              <DropdownMenuLabel className={cn(menuLabelClassName, "pt-4")}>
                {tChat("contextPanel.labels.workspace")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                className={menuItemClassName}
                disabled={disabled || runningAction !== null}
                onSelect={() => setDialogMode("branch")}
              >
                <GitBranch className="size-4" />
                {tChat("contextPanel.createDialog.createBranch")}
              </DropdownMenuItem>
              {canCreateWorktree ? (
                <DropdownMenuItem
                  className={menuItemClassName}
                  disabled={disabled || runningAction !== null}
                  onSelect={() => setDialogMode("worktree")}
                >
                  <GitFork className="size-4" />
                  {tChat("contextPanel.createDialog.createWorktree")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className={menuItemClassName}
                disabled={disabled || runningAction !== null}
                onSelect={() =>
                  void runAction(
                    "fetch",
                    () => onFetch(currentPath),
                    "fetchSuccess",
                    "fetchError",
                  )
                }
              >
                {runningAction === "fetch" ? (
                  <Spinner className="size-4" />
                ) : (
                  <Download className="size-4" />
                )}
                {tChat("contextPanel.actions.fetchRemoteStatus")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className={menuItemClassName}
                disabled={disabled || runningAction !== null}
                onSelect={() =>
                  void runAction(
                    "pull",
                    () => onPull(currentPath),
                    "pullSuccess",
                    "pullError",
                  )
                }
              >
                {runningAction === "pull" ? (
                  <Spinner className="size-4" />
                ) : (
                  <GitPullRequest className="size-4" />
                )}
                {pullLabel}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {canUseGitActions && gitState ? (
        <WorkspaceCreateDialog
          mode={dialogMode}
          gitState={gitState}
          currentPath={currentPath}
          activeBranch={activeBranch}
          onClose={() => setDialogMode(null)}
          onCreateBranch={onCreateBranch}
          onCreateWorktree={onCreateWorktree}
          onWorktreeCreated={onWorktreeCreated}
        />
      ) : null}

      {onRemoveWorkspace && shouldConfirmRemoval ? (
        <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
          <DialogContent className="max-w-[600px] gap-0 overflow-hidden p-0">
            <DialogHeader className="gap-3 px-6 pb-5 pt-6 pr-14">
              <DialogTitle className="text-xl font-semibold">
                {removeDialogTitle}
              </DialogTitle>
              <DialogDescription className="text-sm leading-6 text-foreground">
                {removeDialogBody}
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="flex-row justify-end border-t px-6 py-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                destructive={shouldCleanupResource}
                disabled={isRemoving}
                onClick={() => void handleRemoveWorkspace()}
              >
                {isRemoving ? <Spinner className="size-4" /> : null}
                {removeDialogAction}
              </Button>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={isRemoving}
                onClick={() => setRemoveDialogOpen(false)}
              >
                {tChat("contextPanel.includedWorkspaces.removeConfirmCancel")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
