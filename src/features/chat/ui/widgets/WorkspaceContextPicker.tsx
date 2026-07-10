import { useCallback, useMemo, useState } from "react";
import { GitBranch, GitFork, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CreatedWorktree, GitState } from "@/shared/types/git";
import { cn } from "@/shared/lib/cn";
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
import { formatErrorMessage } from "./formatError";
import {
  type CreatedWorkspaceWorktreeContext,
  WorkspaceCreateDialog,
  type WorkspaceCreateMode,
} from "./WorkspaceCreateDialog";
import { shortenPath } from "./workspacePath";

interface WorkspaceContextPickerProps {
  gitState: GitState;
  currentPath: string;
  activeBranch: string | null;
  disabled?: boolean;
  onSelectWorktree: (path: string, branch: string | null) => void;
  onSwitchBranch: (path: string, branch: string) => Promise<void>;
  onStashAndSwitch: (path: string, branch: string) => Promise<void>;
  canCreateWorktree: boolean;
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
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSamePath(
  a: string | null | undefined,
  b: string | null | undefined,
) {
  return Boolean(a && b && normalizePath(a) === normalizePath(b));
}

function worktreeName(path: string) {
  return normalizePath(path).split("/").at(-1) ?? path;
}

export function WorkspaceContextPicker({
  gitState,
  currentPath,
  activeBranch,
  disabled = false,
  onSelectWorktree,
  onSwitchBranch,
  onStashAndSwitch,
  canCreateWorktree,
  onCreateBranch,
  onCreateWorktree,
  onWorktreeCreated,
}: WorkspaceContextPickerProps) {
  const { t } = useTranslation("chat");
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [worktreeSearch, setWorktreeSearch] = useState("");
  const [branchSearch, setBranchSearch] = useState("");
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [createMode, setCreateMode] = useState<WorkspaceCreateMode | null>(
    null,
  );

  const worktreeByBranch = useMemo(
    () =>
      new Map(
        gitState.worktrees
          .filter((worktree) => worktree.branch)
          .map((worktree) => [worktree.branch as string, worktree]),
      ),
    [gitState.worktrees],
  );
  const visibleWorktrees = gitState.worktrees.filter((worktree) => {
    const query = worktreeSearch.trim().toLowerCase();
    return (
      !query ||
      worktree.path.toLowerCase().includes(query) ||
      worktree.branch?.toLowerCase().includes(query)
    );
  });
  const branches = Array.from(
    new Set(
      activeBranch && !gitState.localBranches.includes(activeBranch)
        ? [activeBranch, ...gitState.localBranches]
        : gitState.localBranches,
    ),
  );
  const visibleBranches = branches.filter((branch) =>
    branch.toLowerCase().includes(branchSearch.trim().toLowerCase()),
  );

  const finishSwitch = useCallback(() => {
    setBranchOpen(false);
    setPendingBranch(null);
  }, []);

  const carrySwitch = useCallback(
    async (branch: string) => {
      setSwitching(true);
      try {
        await onSwitchBranch(currentPath, branch);
        finishSwitch();
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
    [currentPath, finishSwitch, onSwitchBranch, t],
  );

  const stashSwitch = useCallback(
    async (branch: string) => {
      setSwitching(true);
      try {
        await onStashAndSwitch(currentPath, branch);
        finishSwitch();
        toast.success(t("contextPanel.picker.stashSuccess", { branch }));
      } catch (error) {
        toast.error(
          formatErrorMessage(error, t("contextPanel.picker.stashError")),
        );
      } finally {
        setSwitching(false);
      }
    },
    [currentPath, finishSwitch, onStashAndSwitch, t],
  );

  const selectBranch = (branch: string) => {
    if (gitState.dirtyFileCount > 0) {
      setPendingBranch(branch);
      return;
    }
    void carrySwitch(branch);
  };

  const pickerClassName = cn(
    "flex min-h-9 w-full items-center gap-2 rounded-sm bg-background/45 px-2.5 py-2 text-left text-sm",
    "transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    "disabled:cursor-not-allowed disabled:opacity-60",
  );
  const optionClassName = cn(
    "flex w-full items-start gap-2 rounded-xs px-2 py-2 text-left text-sm",
    "hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:outline-none",
    "disabled:cursor-default disabled:text-muted-foreground",
  );

  return (
    <>
      <div className="space-y-3 border-t border-border/60 pt-3">
        <div className="space-y-1.5">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("contextPanel.picker.worktrees")}
            </p>
            {canCreateWorktree ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-6 rounded-sm"
                disabled={disabled}
                aria-label={t("contextPanel.createDialog.createWorktree")}
                title={t("contextPanel.createDialog.createWorktree")}
                onClick={() => setCreateMode("worktree")}
              >
                <Plus className="size-3.5" />
              </Button>
            ) : null}
          </div>
          <Popover
            open={worktreeOpen}
            onOpenChange={(open) => {
              setWorktreeOpen(open);
              if (!open) setWorktreeSearch("");
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className={pickerClassName}
                disabled={disabled}
                aria-label={t("contextPanel.picker.selectWorktree")}
              >
                <GitFork className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {shortenPath(currentPath)}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="chat-context-dropdown-surface w-[var(--radix-popover-trigger-width)] min-w-72 rounded-sm p-2"
            >
              <div className="mb-2 flex h-9 items-center gap-2 rounded-xs bg-muted/60 px-2.5 text-muted-foreground">
                <Search className="size-3.5" />
                <input
                  type="search"
                  value={worktreeSearch}
                  onChange={(event) => setWorktreeSearch(event.target.value)}
                  placeholder={t("contextPanel.picker.search")}
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none"
                />
              </div>
              <div className="max-h-64 overflow-y-auto">
                {visibleWorktrees.map((worktree) => (
                  <button
                    key={worktree.path}
                    type="button"
                    className={optionClassName}
                    aria-current={isSamePath(worktree.path, currentPath)}
                    onClick={() => {
                      onSelectWorktree(worktree.path, worktree.branch);
                      setWorktreeOpen(false);
                    }}
                  >
                    <GitFork className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {worktreeName(worktree.path)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {shortenPath(worktree.path)}
                      </span>
                    </span>
                  </button>
                ))}
                {visibleWorktrees.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">
                    {t("contextPanel.picker.noResults")}
                  </p>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="space-y-1.5">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("contextPanel.picker.branchLabel")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6 rounded-sm"
              disabled={disabled}
              aria-label={t("contextPanel.createDialog.createBranch")}
              title={t("contextPanel.createDialog.createBranch")}
              onClick={() => setCreateMode("branch")}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
          <Popover
            open={branchOpen}
            onOpenChange={(open) => {
              setBranchOpen(open);
              if (!open) setBranchSearch("");
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className={pickerClassName}
                disabled={disabled}
                aria-label={t("contextPanel.picker.selectBranch")}
              >
                <GitBranch className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {activeBranch ?? t("contextPanel.picker.noBranch")}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="chat-context-dropdown-surface w-[var(--radix-popover-trigger-width)] min-w-72 rounded-sm p-2"
            >
              <div className="mb-2 flex h-9 items-center gap-2 rounded-xs bg-muted/60 px-2.5 text-muted-foreground">
                <Search className="size-3.5" />
                <input
                  type="search"
                  value={branchSearch}
                  onChange={(event) => setBranchSearch(event.target.value)}
                  placeholder={t("contextPanel.picker.search")}
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none"
                />
              </div>
              <div className="max-h-64 overflow-y-auto">
                {visibleBranches.map((branch) => {
                  const owningWorktree = worktreeByBranch.get(branch);
                  const current = branch === activeBranch;
                  const checkedOutElsewhere = Boolean(
                    owningWorktree &&
                      !isSamePath(owningWorktree.path, currentPath),
                  );
                  return (
                    <button
                      key={branch}
                      type="button"
                      className={optionClassName}
                      disabled={switching || current || checkedOutElsewhere}
                      aria-current={current}
                      onClick={() => selectBranch(branch)}
                    >
                      <GitBranch className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{branch}</span>
                      {checkedOutElsewhere ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t("contextPanel.picker.checkedOutIn", {
                            worktree: worktreeName(owningWorktree?.path ?? ""),
                          })}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {visibleBranches.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">
                    {t("contextPanel.picker.noResults")}
                  </p>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <WorkspaceCreateDialog
        mode={createMode}
        gitState={gitState}
        currentPath={currentPath}
        activeBranch={activeBranch}
        onClose={() => setCreateMode(null)}
        onCreateBranch={onCreateBranch}
        onCreateWorktree={onCreateWorktree}
        onWorktreeCreated={onWorktreeCreated}
      />

      <AlertDialog
        open={pendingBranch !== null}
        onOpenChange={(open) => !open && setPendingBranch(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("contextPanel.picker.dirtyTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("contextPanel.picker.dirtyDescription", {
                count: gitState.dirtyFileCount,
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
              onClick={() => pendingBranch && void carrySwitch(pendingBranch)}
            >
              {t("contextPanel.picker.carryChanges")}
            </AlertDialogAction>
            <AlertDialogAction
              disabled={switching}
              onClick={() => pendingBranch && void stashSwitch(pendingBranch)}
            >
              {t("contextPanel.picker.stashAndSwitch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
