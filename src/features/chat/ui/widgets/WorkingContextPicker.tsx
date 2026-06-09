import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  IconChevronDown,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
} from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { buttonVariants } from "@/shared/ui/button";
import { RowButton } from "@/shared/ui/row-button";
import type { GitState } from "@/shared/types/git";
import type { ActiveWorkspace } from "../../stores/chatSessionStore";
import { formatErrorMessage } from "./formatError";

interface WorkingContextPickerProps {
  currentProjectPath: string | null;
  gitState: GitState | undefined;
  activeContext: ActiveWorkspace | undefined;
  onSelect: (context: ActiveWorkspace) => void;
  onSwitchBranch: (path: string, branch: string) => Promise<void>;
  onStashAndSwitch: (path: string, branch: string) => Promise<void>;
  onChangeFolder?: () => Promise<void> | void;
  isChangingFolder?: boolean;
}

export function shortenPath(fullPath: string): string {
  const home =
    typeof window !== "undefined"
      ? fullPath.replace(/^\/Users\/[^/]+/, "~")
      : fullPath;
  const parts = home.split("/");
  if (parts.length > 3) {
    return `…/${parts.slice(-2).join("/")}`;
  }
  return home;
}

function worktreeName(fullPath: string): string {
  const normalizedPath = normalizeComparablePath(fullPath);
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] || fullPath;
}

function normalizeComparablePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSamePath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeComparablePath(a) === normalizeComparablePath(b);
}

export function WorkingContextPicker({
  currentProjectPath,
  gitState,
  activeContext,
  onSelect,
  onSwitchBranch,
  onStashAndSwitch,
  onChangeFolder,
  isChangingFolder = false,
}: WorkingContextPickerProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<ActiveWorkspace | null>(
    null,
  );
  const [switching, setSwitching] = useState(false);

  const worktrees = gitState?.worktrees ?? [];
  const localBranches = gitState?.localBranches ?? [];
  const dirtyFileCount = gitState?.dirtyFileCount ?? 0;
  const defaultWorktreePath =
    worktrees.find(
      (worktree) =>
        normalizeComparablePath(worktree.path) ===
        normalizeComparablePath(currentProjectPath ?? ""),
    )?.path ?? worktrees[0]?.path;
  const currentPath = activeContext?.path ?? defaultWorktreePath;
  const activeWorktree =
    worktrees.find((worktree) => isSamePath(worktree.path, currentPath)) ??
    null;
  const activeBranch =
    activeWorktree?.branch ?? activeContext?.branch ?? gitState?.currentBranch;
  const activeWorktreeLabel = activeWorktree
    ? shortenPath(activeWorktree.path)
    : currentPath
      ? shortenPath(currentPath)
      : currentProjectPath
        ? shortenPath(currentProjectPath)
        : undefined;
  const activeBranchLabel = activeBranch ?? t("contextPanel.states.detached");
  const mainWorktreePath =
    gitState?.mainWorktreePath ??
    worktrees.find((worktree) => worktree.isMain)?.path ??
    null;
  const worktreeByBranch = useMemo(
    () =>
      new Map(
        worktrees
          .filter((worktree) => worktree.branch)
          .map((worktree) => [worktree.branch as string, worktree]),
      ),
    [worktrees],
  );

  const handleWorktreeSelect = useCallback(
    (path: string, branch: string | null) => {
      onSelect({ path, branch });
      setOpen(false);
    },
    [onSelect],
  );

  const finishSwitch = useCallback(
    (path: string, branch: string) => {
      onSelect({ path, branch });
      setOpen(false);
      setPendingSwitch(null);
    },
    [onSelect],
  );

  const performCarrySwitch = useCallback(
    async (path: string, branch: string) => {
      setSwitching(true);
      try {
        await onSwitchBranch(path, branch);
        finishSwitch(path, branch);
      } catch (error) {
        toast.error(
          formatErrorMessage(
            error,
            t("contextPanel.picker.switchError", { branch }),
          ),
        );
      } finally {
        setSwitching(false);
      }
    },
    [onSwitchBranch, finishSwitch, t],
  );

  const performStashSwitch = useCallback(
    async (path: string, branch: string) => {
      setSwitching(true);
      try {
        await onStashAndSwitch(path, branch);
        finishSwitch(path, branch);
        toast.success(t("contextPanel.picker.stashSuccess", { branch }));
      } catch (error) {
        toast.error(
          formatErrorMessage(error, t("contextPanel.picker.stashError")),
        );
      } finally {
        setSwitching(false);
      }
    },
    [onStashAndSwitch, finishSwitch, t],
  );

  const getBranchTargetPath = useCallback(
    (branch: string) => {
      const worktreeForBranch = worktreeByBranch.get(branch);
      if (worktreeForBranch) {
        return worktreeForBranch.path;
      }
      if (activeWorktree?.isMain) {
        return currentPath ?? mainWorktreePath;
      }
      return mainWorktreePath ?? currentPath;
    },
    [activeWorktree?.isMain, currentPath, mainWorktreePath, worktreeByBranch],
  );

  const handleBranchSelect = useCallback(
    (branch: string) => {
      const worktreeForBranch = worktreeByBranch.get(branch);
      if (
        worktreeForBranch &&
        !isSamePath(worktreeForBranch.path, currentPath)
      ) {
        handleWorktreeSelect(worktreeForBranch.path, worktreeForBranch.branch);
        return;
      }
      const targetPath = getBranchTargetPath(branch);
      if (!targetPath) return;
      if (isSamePath(targetPath, currentPath) && dirtyFileCount > 0) {
        setPendingSwitch({ path: targetPath, branch });
      } else {
        void performCarrySwitch(targetPath, branch);
      }
    },
    [
      currentPath,
      dirtyFileCount,
      getBranchTargetPath,
      handleWorktreeSelect,
      performCarrySwitch,
      worktreeByBranch,
    ],
  );

  const isWorktreeSelected = (path: string) => {
    return isSamePath(currentPath, path);
  };

  if (!gitState?.isGitRepo) return null;

  const hasWorktrees = worktrees.length > 0;
  const hasBranches = localBranches.length > 0;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <RowButton
            variant="field"
            aria-label={t("contextPanel.picker.selectContext")}
            icon={
              <IconFolder className="size-4 shrink-0 text-muted-foreground" />
            }
            label={activeWorktreeLabel ?? t("contextPanel.empty.folderNotSet")}
            description={t("contextPanel.picker.checkedOutBranch", {
              branch: activeBranchLabel,
            })}
            trailing={
              <IconChevronDown className="size-3 shrink-0 text-muted-foreground" />
            }
          />
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={6}
          className="max-h-80 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-y-auto p-1.5 font-normal"
        >
          {hasWorktrees ? (
            <div>
              <p className="px-2 pb-1.5 pt-1 text-xxs font-normal text-sidebar-foreground/55">
                {t("contextPanel.picker.worktrees")}
              </p>
              {worktrees.map((wt) => (
                <RowButton
                  key={wt.path}
                  selected={isWorktreeSelected(wt.path)}
                  onClick={() => handleWorktreeSelect(wt.path, wt.branch)}
                  icon={
                    <IconFolder className="size-4 shrink-0 text-muted-foreground" />
                  }
                  label={worktreeName(wt.path)}
                  description={t("contextPanel.picker.checkedOutBranch", {
                    branch: wt.branch ?? t("contextPanel.states.detached"),
                  })}
                />
              ))}
            </div>
          ) : null}

          {hasBranches ? (
            <div
              className={hasWorktrees ? "mt-1 border-t border-border pt-1" : ""}
            >
              <p className="px-2 pb-1.5 pt-1 text-xxs font-normal text-sidebar-foreground/55">
                {t("contextPanel.picker.allBranches")}
              </p>
              {localBranches.map((branch) => {
                const branchTargetPath = getBranchTargetPath(branch);
                const isCurrentBranch = branch === activeBranch;
                const branchMeta = isCurrentBranch
                  ? t("contextPanel.picker.currentBranch")
                  : branchTargetPath
                    ? shortenPath(branchTargetPath)
                    : null;

                return (
                  <RowButton
                    key={branch}
                    disabled={switching || isCurrentBranch}
                    onClick={() => handleBranchSelect(branch)}
                    icon={
                      <IconGitBranch className="size-4 shrink-0 text-muted-foreground" />
                    }
                    label={branch}
                    description={branchMeta}
                  />
                );
              })}
            </div>
          ) : null}

          {onChangeFolder ? (
            <div
              className={
                hasWorktrees || hasBranches
                  ? "mt-1 border-t border-border pt-1"
                  : ""
              }
            >
              <RowButton
                disabled={isChangingFolder}
                onClick={() => {
                  setOpen(false);
                  void onChangeFolder();
                }}
                icon={
                  <IconFolderOpen className="size-4 shrink-0 text-muted-foreground" />
                }
                label={t("contextPanel.picker.changeFolder")}
              />
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={pendingSwitch !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPendingSwitch(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("contextPanel.picker.dirtyTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("contextPanel.picker.dirtyDescription", {
                count: dirtyFileCount,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={switching}>
              {t("contextPanel.picker.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={switching}
              className={buttonVariants({ variant: "secondary" })}
              onClick={() => {
                if (pendingSwitch?.branch) {
                  void performCarrySwitch(
                    pendingSwitch.path,
                    pendingSwitch.branch,
                  );
                }
              }}
            >
              {t("contextPanel.picker.carryChanges")}
            </AlertDialogAction>
            <AlertDialogAction
              disabled={switching}
              onClick={() => {
                if (pendingSwitch?.branch) {
                  void performStashSwitch(
                    pendingSwitch.path,
                    pendingSwitch.branch,
                  );
                }
              }}
            >
              {t("contextPanel.picker.stashAndSwitch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
