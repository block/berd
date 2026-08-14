import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  IconChevronDown,
  IconFolder,
  IconFolderCode,
  IconGitBranch,
  IconGitFork,
  IconPlus,
  IconSearch,
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
import { Button, buttonVariants } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_MENU_HOVER_TRANSITION_CLASS } from "@/shared/ui/sidebar-tokens";
import type { GitState } from "@/shared/types/git";
import type { ActiveWorkspace } from "../../stores/chatSessionStore";
import { WorkspaceCreateDialog } from "./WorkspaceCreateDialog";
import type { WorkspaceIdentityIconKind } from "./WorkspaceIdentity";
import { formatErrorMessage } from "./formatError";
import { shortenPath } from "./workspacePath";

interface WorkingContextPickerProps {
  currentProjectPath: string | null;
  gitState: GitState | undefined;
  activeContext: ActiveWorkspace | undefined;
  onSelect: (context: ActiveWorkspace) => void;
  onSwitchBranch: (path: string, branch: string) => Promise<void>;
  onStashAndSwitch: (path: string, branch: string) => Promise<void>;
  onCreateBranch: (
    path: string,
    name: string,
    baseBranch: string,
  ) => Promise<void>;
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

function includesSearch(value: string | null | undefined, query: string) {
  return Boolean(value?.toLowerCase().includes(query));
}

function IconWithActiveDot({
  active,
  children,
  className,
}: {
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)}>
      {children}
      {active ? (
        <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-success ring-1 ring-background" />
      ) : null}
    </span>
  );
}

function iconKindForWorktree(
  worktree: { isMain: boolean } | null,
): WorkspaceIdentityIconKind {
  if (!worktree) return "folder";
  return worktree.isMain ? "repository" : "worktree";
}

function WorkspacePickerIcon({
  kind,
  className,
}: {
  kind: WorkspaceIdentityIconKind;
  className?: string;
}) {
  if (kind === "worktree") {
    return <IconGitFork className={className} />;
  }
  if (kind === "repository") {
    return <IconFolderCode className={className} />;
  }
  return <IconFolder className={className} />;
}

export function WorkingContextPicker({
  currentProjectPath,
  gitState,
  activeContext,
  onSelect,
  onSwitchBranch,
  onStashAndSwitch,
  onCreateBranch,
}: WorkingContextPickerProps) {
  const { t } = useTranslation("chat");
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [worktreeSearchQuery, setWorktreeSearchQuery] = useState("");
  const [branchSearchQuery, setBranchSearchQuery] = useState("");
  const [worktreeResultsScrolled, setWorktreeResultsScrolled] = useState(false);
  const [branchResultsScrolled, setBranchResultsScrolled] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<ActiveWorkspace | null>(
    null,
  );
  const [branchCreateOpen, setBranchCreateOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const worktrees = gitState?.worktrees ?? [];
  const localBranches = gitState?.localBranches ?? [];
  const dirtyFileCount = gitState?.dirtyFileCount ?? 0;
  const defaultWorktreePath =
    worktrees.find((worktree) => isSamePath(worktree.path, currentProjectPath))
      ?.path ?? worktrees[0]?.path;
  const currentPath = activeContext?.path ?? defaultWorktreePath;
  const activeWorktree =
    worktrees.find((worktree) => isSamePath(worktree.path, currentPath)) ??
    null;
  const activeBranch =
    activeWorktree?.branch ?? activeContext?.branch ?? gitState?.currentBranch;
  const activeWorktreeLabel = activeWorktree
    ? worktreeName(activeWorktree.path)
    : currentPath
      ? worktreeName(currentPath)
      : currentProjectPath
        ? worktreeName(currentProjectPath)
        : undefined;
  const pickerPrimaryLabel =
    activeWorktreeLabel ?? t("contextPanel.empty.folderNotSet");
  const pickerSecondaryLabel = currentPath
    ? shortenPath(currentPath)
    : undefined;
  const worktreeByBranch = useMemo(
    () =>
      new Map(
        worktrees
          .filter((worktree) => worktree.branch)
          .map((worktree) => [worktree.branch as string, worktree]),
      ),
    [worktrees],
  );
  const normalizedWorktreeSearchQuery = worktreeSearchQuery
    .trim()
    .toLowerCase();
  const normalizedBranchSearchQuery = branchSearchQuery.trim().toLowerCase();
  const visibleWorktrees = useMemo(
    () =>
      worktrees.filter((worktree) => {
        if (!normalizedWorktreeSearchQuery) return true;
        return (
          includesSearch(
            worktreeName(worktree.path),
            normalizedWorktreeSearchQuery,
          ) ||
          includesSearch(worktree.path, normalizedWorktreeSearchQuery) ||
          includesSearch(worktree.branch, normalizedWorktreeSearchQuery)
        );
      }),
    [normalizedWorktreeSearchQuery, worktrees],
  );
  const visibleBranches = useMemo(() => {
    const branches = [...localBranches];
    if (activeBranch && !branches.includes(activeBranch)) {
      branches.unshift(activeBranch);
    }

    return branches.filter((branch) => {
      const owningWorktree = worktreeByBranch.get(branch);
      if (!normalizedBranchSearchQuery) return true;
      return (
        includesSearch(branch, normalizedBranchSearchQuery) ||
        includesSearch(owningWorktree?.path, normalizedBranchSearchQuery)
      );
    });
  }, [
    activeBranch,
    localBranches,
    normalizedBranchSearchQuery,
    worktreeByBranch,
  ]);

  const handleWorktreeSelect = useCallback(
    (path: string, branch: string | null) => {
      onSelect({ path, branch });
      setWorktreeOpen(false);
    },
    [onSelect],
  );

  const finishSwitch = useCallback(
    (path: string, branch: string) => {
      onSelect({ path, branch });
      setBranchOpen(false);
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
        const errorMessage = formatErrorMessage(
          error,
          t("contextPanel.picker.stashError"),
        );
        toast.error(
          `${t("contextPanel.picker.changesStashed")} ${errorMessage}`,
        );
      } finally {
        setSwitching(false);
      }
    },
    [onStashAndSwitch, finishSwitch, t],
  );

  const handleBranchSelect = useCallback(
    (branch: string, targetPath: string | null) => {
      const worktreeForBranch = worktreeByBranch.get(branch);
      if (
        worktreeForBranch &&
        !isSamePath(worktreeForBranch.path, currentPath)
      ) {
        return;
      }
      if (!targetPath) return;
      if (isSamePath(targetPath, currentPath) && dirtyFileCount > 0) {
        setPendingSwitch({ path: targetPath, branch });
      } else {
        void performCarrySwitch(targetPath, branch);
      }
    },
    [currentPath, dirtyFileCount, performCarrySwitch, worktreeByBranch],
  );

  const handleWorktreeOpenChange = useCallback((isOpen: boolean) => {
    setWorktreeOpen(isOpen);
    if (!isOpen) {
      setWorktreeSearchQuery("");
      setWorktreeResultsScrolled(false);
    }
  }, []);

  const handleBranchOpenChange = useCallback((isOpen: boolean) => {
    setBranchOpen(isOpen);
    if (!isOpen) {
      setBranchSearchQuery("");
      setBranchResultsScrolled(false);
    }
  }, []);

  const handleCreateBranchClick = useCallback(() => {
    setBranchOpen(false);
    setBranchCreateOpen(true);
  }, []);

  const isWorktreeSelected = (path: string) => {
    return isSamePath(currentPath, path);
  };

  if (!gitState?.isGitRepo) return null;

  const hasWorktrees = worktrees.length > 0;
  const hasVisibleWorktrees = visibleWorktrees.length > 0;
  const hasVisibleBranches = visibleBranches.length > 0 && Boolean(currentPath);
  // Hover/selected fills use `muted`: in dark it equals the old
  // `sidebar-accent` value (gray-700), while in light it stays visible on
  // white surfaces where `sidebar-accent` (gray-50) disappears. rounded-sm
  // rows sit concentric inside the rounded-md popover's p-1.5 padding
  // (12px + 6px = 18px); the active row carries the selected fill.
  const pickerRowClassName = cn(
    "group flex w-full items-start gap-3 rounded-sm px-2 py-2.5 text-left",
    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
    "enabled:hover:bg-muted focus-visible:bg-muted focus-visible:outline-none aria-[current=true]:bg-muted",
  );
  const branchRowClassName = cn(
    "group flex w-full items-center gap-3 rounded-sm px-2 py-2.5 text-left",
    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
    "enabled:hover:bg-muted focus-visible:bg-muted focus-visible:outline-none aria-[current=true]:bg-muted",
  );

  return (
    <>
      <div className="space-y-2">
        <Popover open={worktreeOpen} onOpenChange={handleWorktreeOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex w-full items-start gap-3 rounded-sm bg-muted/60 px-3.5 py-2.5",
                "text-sm text-foreground",
                SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
                "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
              aria-label={t("contextPanel.picker.selectWorktree")}
            >
              <WorkspacePickerIcon
                kind={iconKindForWorktree(activeWorktree)}
                className="mt-0.5 size-4 shrink-0 text-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-left">
                <span className="block truncate text-foreground">
                  {pickerPrimaryLabel}
                </span>
                {pickerSecondaryLabel ? (
                  <span className="block truncate text-sm text-muted-foreground">
                    {pickerSecondaryLabel}
                  </span>
                ) : null}
              </span>
              <IconChevronDown className="mt-0.5 size-4 shrink-0 text-foreground" />
            </button>
          </PopoverTrigger>

          <PopoverContent
            align="start"
            sideOffset={8}
            className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-72 flex-col overflow-hidden rounded-md bg-card p-1.5 text-sm font-normal"
          >
            <div className="mb-2 flex h-10 items-center gap-2 rounded-sm border border-transparent px-3 text-muted-foreground transition-colors hover:bg-muted/60 focus-within:border-transparent focus-within:ring-0">
              <IconSearch className="size-4 shrink-0" />
              <input
                type="search"
                value={worktreeSearchQuery}
                onChange={(event) => {
                  setWorktreeSearchQuery(event.target.value);
                  setWorktreeResultsScrolled(false);
                }}
                placeholder={t("contextPanel.picker.search")}
                className="chat-context-search-input min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus:border-transparent focus:outline-none focus:ring-0 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0"
              />
            </div>

            <div className="chat-context-dropdown-results">
              <div
                className="chat-context-dropdown-results-scroll scrollbar-none pb-[2px]"
                data-scrolled={worktreeResultsScrolled ? "true" : "false"}
                onScroll={(event) =>
                  setWorktreeResultsScrolled(event.currentTarget.scrollTop > 0)
                }
              >
                {hasWorktrees && hasVisibleWorktrees ? (
                  <div className="chat-context-dropdown-row-list space-y-0.5">
                    {visibleWorktrees.map((worktree) => {
                      const isCurrentWorktree = isWorktreeSelected(
                        worktree.path,
                      );
                      return (
                        <button
                          key={worktree.path}
                          type="button"
                          aria-current={isCurrentWorktree ? "true" : undefined}
                          className={pickerRowClassName}
                          onClick={() =>
                            handleWorktreeSelect(worktree.path, worktree.branch)
                          }
                        >
                          <IconWithActiveDot
                            active={isCurrentWorktree}
                            className="mt-0.5"
                          >
                            <WorkspacePickerIcon
                              kind={iconKindForWorktree(worktree)}
                              className="size-4 text-foreground"
                            />
                          </IconWithActiveDot>
                          <div className="min-w-0 flex-1">
                            <span className="block truncate font-normal text-foreground">
                              {worktreeName(worktree.path)}
                            </span>
                            <span className="block truncate text-sm text-muted-foreground">
                              {shortenPath(worktree.path)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {!hasVisibleWorktrees ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">
                    {t("contextPanel.picker.noResults")}
                  </p>
                ) : null}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <Popover open={branchOpen} onOpenChange={handleBranchOpenChange}>
          <div className="flex items-center justify-between gap-2 pt-2">
            <p className="text-sm font-normal text-muted-foreground">
              {t("contextPanel.picker.branchLabel")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleCreateBranchClick}
              className="rounded-full"
              aria-label={t("contextPanel.createDialog.createBranch")}
              tooltip={t("contextPanel.createDialog.createBranch")}
            >
              <IconPlus className="size-4" />
            </Button>
          </div>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex w-full items-start gap-3 rounded-sm bg-muted/60 px-3.5 py-2.5",
                "text-sm text-foreground",
                SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
                "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
              aria-label={t("contextPanel.picker.selectBranch")}
            >
              <IconGitBranch className="mt-0.5 size-4 shrink-0 text-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">
                <span className="block truncate text-foreground">
                  {activeBranch ?? t("contextPanel.picker.noBranch")}
                </span>
              </span>
              <IconChevronDown className="mt-0.5 size-4 shrink-0 text-foreground" />
            </button>
          </PopoverTrigger>

          <PopoverContent
            align="start"
            sideOffset={8}
            className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-72 flex-col overflow-hidden rounded-md bg-card p-1.5 text-sm font-normal"
          >
            <div className="mb-2 flex h-10 items-center gap-2 rounded-sm border border-transparent px-3 text-muted-foreground transition-colors hover:bg-muted/60 focus-within:border-transparent focus-within:ring-0">
              <IconSearch className="size-4 shrink-0" />
              <input
                type="search"
                value={branchSearchQuery}
                onChange={(event) => {
                  setBranchSearchQuery(event.target.value);
                  setBranchResultsScrolled(false);
                }}
                placeholder={t("contextPanel.picker.search")}
                className="chat-context-search-input min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus:border-transparent focus:outline-none focus:ring-0 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0"
              />
            </div>
            <div className="chat-context-dropdown-results">
              <div
                className="chat-context-dropdown-results-scroll scrollbar-none pb-[2px]"
                data-scrolled={branchResultsScrolled ? "true" : "false"}
                onScroll={(event) =>
                  setBranchResultsScrolled(event.currentTarget.scrollTop > 0)
                }
              >
                {hasVisibleBranches ? (
                  <div className="chat-context-dropdown-row-list space-y-0.5">
                    {visibleBranches.map((branch) => {
                      const owningWorktree = worktreeByBranch.get(branch);
                      const isCurrentBranch = branch === activeBranch;
                      const isCheckedOutElsewhere =
                        Boolean(owningWorktree) &&
                        !isSamePath(owningWorktree?.path, currentPath);
                      const isDisabled =
                        switching ||
                        isCurrentBranch ||
                        isCheckedOutElsewhere ||
                        !currentPath;

                      return (
                        <button
                          key={branch}
                          type="button"
                          disabled={isDisabled}
                          aria-current={isCurrentBranch ? "true" : undefined}
                          className={cn(
                            branchRowClassName,
                            "disabled:cursor-default disabled:opacity-100",
                            isCheckedOutElsewhere &&
                              "text-muted-foreground [&_svg]:text-muted-foreground [&_span]:text-muted-foreground",
                          )}
                          onClick={() =>
                            handleBranchSelect(branch, currentPath ?? null)
                          }
                        >
                          <IconGitBranch className="size-4 shrink-0 text-foreground" />
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-foreground">
                              {branch}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {!hasVisibleBranches ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">
                    {t("contextPanel.picker.noResults")}
                  </p>
                ) : null}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

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
              className={buttonVariants({ variant: "subtle" })}
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

      <WorkspaceCreateDialog
        mode={branchCreateOpen ? "branch" : null}
        gitState={gitState}
        currentPath={currentPath ?? currentProjectPath ?? ""}
        onClose={() => setBranchCreateOpen(false)}
        onContextChange={onSelect}
        onCreateBranch={onCreateBranch}
      />
    </>
  );
}
