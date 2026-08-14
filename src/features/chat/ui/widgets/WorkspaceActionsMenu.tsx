import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  IconDots,
  IconDownload,
  IconFolderOpen,
  IconGitFork,
  IconGitPullRequest,
  IconTerminal2,
} from "@tabler/icons-react";
import type { CreatedWorktree, GitState } from "@/shared/types/git";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
} from "@/shared/ui/sidebar-tokens";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Spinner } from "@/shared/ui/spinner";
import type { ActiveWorkspace } from "../../stores/chatSessionStore";
import { formatErrorMessage } from "./formatError";
import {
  WorkspaceCreateDialog,
  type WorkspaceCreateMode,
} from "./WorkspaceCreateDialog";

interface WorkspaceActionsMenuProps {
  currentProjectPath: string;
  gitState: GitState;
  activeContext: ActiveWorkspace | undefined;
  disabled?: boolean;
  onContextChange: (context: ActiveWorkspace) => void;
  onToggleTerminal?: () => void;
  onChangeFolder?: () => Promise<void> | void;
  isChangingFolder?: boolean;
  onFetch: (path: string) => Promise<void>;
  onPull: (path: string) => Promise<void>;
  onCreateWorktree: (
    path: string,
    name: string,
    branch: string,
    createBranch: boolean,
    baseBranch?: string,
  ) => Promise<CreatedWorktree>;
}

export function WorkspaceActionsMenu({
  currentProjectPath,
  gitState,
  activeContext,
  disabled = false,
  onContextChange,
  onToggleTerminal,
  onChangeFolder,
  isChangingFolder = false,
  onFetch,
  onPull,
  onCreateWorktree,
}: WorkspaceActionsMenuProps) {
  const { t } = useTranslation("chat");
  const [dialogMode, setDialogMode] = useState<WorkspaceCreateMode | null>(
    null,
  );
  const [runningAction, setRunningAction] = useState<"fetch" | "pull" | null>(
    null,
  );

  const defaultWorktreePath =
    gitState.worktrees.find((worktree) => worktree.path === currentProjectPath)
      ?.path ??
    gitState.worktrees[0]?.path ??
    currentProjectPath;
  const currentPath = activeContext?.path ?? defaultWorktreePath;
  const pullLabel =
    gitState.incomingCommitCount > 0
      ? t("contextPanel.git.pullCommitCount", {
          count: gitState.incomingCommitCount,
        })
      : t("contextPanel.git.pull");

  const runAction = async (
    action: "fetch" | "pull",
    run: () => Promise<void>,
    successKey: "fetchSuccess" | "pullSuccess",
    errorKey: "fetchError" | "pullError",
  ) => {
    setRunningAction(action);
    try {
      await run();
      toast.success(t(`contextPanel.git.${successKey}`));
    } catch (error) {
      toast.error(formatErrorMessage(error, t(`contextPanel.git.${errorKey}`)));
    } finally {
      setRunningAction(null);
    }
  };

  if (!currentPath) {
    return null;
  }

  const menuItemClassName = cn(
    SIDEBAR_ROW_HEIGHT_CLASS,
    SIDEBAR_ROW_ICON_TEXT_GAP_CLASS,
    SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
    SIDEBAR_NAV_TEXT_CLASS,
    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
    "rounded-sm pl-2 pr-3 text-foreground hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted",
  );
  const menuLabelClassName =
    "px-2 pb-1 text-sm font-normal text-muted-foreground";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-full text-muted-foreground hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
            aria-label={t("contextPanel.actions.openWorkspaceMenu")}
          >
            <IconDots className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          className="w-64 rounded-md bg-card px-1.5 pb-[6px] pt-3"
        >
          {onToggleTerminal ? (
            <DropdownMenuItem
              className={menuItemClassName}
              onSelect={() => onToggleTerminal()}
            >
              <IconTerminal2 className="size-4" />
              {t("terminal.open")}
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuLabel
            className={cn(
              menuLabelClassName,
              onToggleTerminal ? "pt-4" : "pt-1",
            )}
          >
            {t("contextPanel.labels.workspace")}
          </DropdownMenuLabel>
          {onChangeFolder ? (
            <DropdownMenuItem
              className={menuItemClassName}
              disabled={disabled || isChangingFolder || runningAction !== null}
              onSelect={() => void onChangeFolder()}
            >
              {isChangingFolder ? (
                <Spinner className="size-4" />
              ) : (
                <IconFolderOpen className="size-4" />
              )}
              {t("contextPanel.picker.changeFolder")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className={menuItemClassName}
            disabled={disabled || runningAction !== null}
            onSelect={() => setDialogMode("worktree")}
          >
            <IconGitFork className="size-4" />
            {t("contextPanel.createDialog.createWorktree")}
          </DropdownMenuItem>
          <DropdownMenuLabel className={cn(menuLabelClassName, "pt-4")}>
            {t("contextPanel.labels.remote")}
          </DropdownMenuLabel>
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
              <IconDownload className="size-4" />
            )}
            {t("contextPanel.actions.fetchRemoteStatus")}
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
              <IconGitPullRequest className="size-4" />
            )}
            {pullLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <WorkspaceCreateDialog
        mode={dialogMode}
        gitState={gitState}
        currentPath={currentPath}
        onClose={() => setDialogMode(null)}
        onContextChange={onContextChange}
        onCreateWorktree={onCreateWorktree}
      />
    </>
  );
}
