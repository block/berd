import { useCallback, useMemo, useState } from "react";
import { ChevronDown, GitBranch, GitFork, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CreatedWorktree, GitState } from "@/shared/types/git";
import { cn } from "@/shared/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Badge } from "@/shared/ui/badge";
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
  onSelectWorktree: (path: string, branch: string | null) => Promise<void>;
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
  ) => Promise<void>;
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

function worktreeLabel(path: string, _branch: string | null | undefined) {
  return worktreeName(path);
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
  const currentWorktree =
    gitState.worktrees.find((worktree) =>
      isSamePath(worktree.path, currentPath),
    ) ?? null;
  const currentWorktreeLabel = currentWorktree
    ? worktreeLabel(currentWorktree.path, currentWorktree.branch)
    : worktreeName(currentPath);
  const visibleWorktrees = gitState.worktrees.filter((worktree) => {
    const query = worktreeSearch.trim().toLowerCase();
    return (
      !query ||
      worktreeLabel(worktree.path, worktree.branch)
        .toLowerCase()
        .includes(query) ||
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

  // Hover/selected fills use `muted`: in dark it equals the old
  // `sidebar-accent` value (gray-700), while in light it stays visible on
  // white surfaces where `sidebar-accent` (gray-50) disappears. The resting
  // fill is `muted/60` to match the legacy picker cards — `background/45`
  // reads darker than the rail surface in dark mode.
  const pickerClassName = cn(
    "group flex min-h-9 w-full items-center gap-2 rounded-sm bg-muted/60 px-2.5 py-2 text-left text-sm",
    "transition-colors enabled:hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    "disabled:cursor-not-allowed disabled:opacity-60",
  );
  // rounded-sm rows sit concentric inside the rounded-md popover's p-1.5
  // padding (12px + 6px = 18px). The active row carries the selected fill.
  const optionClassName = cn(
    "flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left text-sm",
    "enabled:hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
    "aria-[current=true]:bg-muted",
    "disabled:cursor-default disabled:text-muted-foreground",
  );

  return (
    <>
      <div className="space-y-3">
        <div className="group/worktree-section space-y-1.5">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <p className="text-sm font-normal text-muted-foreground">
              {t("contextPanel.picker.worktrees")}
            </p>
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
                  {currentWorktreeLabel}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              // Rail dropdowns live on the card surface (the rail glass
              // derives from card), not the darker overflow-popover surface,
              // and share the rail container's rounded-md radius.
              className="w-[var(--radix-popover-trigger-width)] rounded-md bg-card p-1.5"
            >
              <div className="mb-2 flex h-9 items-center gap-2 rounded-sm px-2.5 text-muted-foreground transition-colors hover:bg-muted/60">
                <Search className="size-3.5" />
                <input
                  type="search"
                  value={worktreeSearch}
                  onChange={(event) => setWorktreeSearch(event.target.value)}
                  placeholder={t("contextPanel.picker.search")}
                  className="chat-context-search-input min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus:border-transparent focus:outline-none focus:ring-0 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0"
                />
              </div>
              <div className="scrollbar-none max-h-64 overflow-y-auto">
                {canCreateWorktree ? (
                  <button
                    type="button"
                    className={cn(optionClassName, "mb-1 text-foreground/70")}
                    disabled={disabled}
                    onClick={() => {
                      setCreateMode("worktree");
                      setWorktreeOpen(false);
                    }}
                  >
                    <Plus className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {t("contextPanel.picker.addWorktree")}
                    </span>
                  </button>
                ) : null}
                {visibleWorktrees.map((worktree) => (
                  <button
                    key={worktree.path}
                    type="button"
                    className={optionClassName}
                    aria-current={isSamePath(worktree.path, currentPath)}
                    onClick={() => {
                      void onSelectWorktree(worktree.path, worktree.branch)
                        .then(() => setWorktreeOpen(false))
                        .catch((error) =>
                          toast.error(
                            formatErrorMessage(
                              error,
                              "Could not switch worktree.",
                            ),
                          ),
                        );
                    }}
                  >
                    <GitFork className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {worktreeLabel(worktree.path, worktree.branch)}
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

        <div className="group/branch-section space-y-1.5">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <p className="text-sm font-normal text-muted-foreground">
              {t("contextPanel.picker.branchLabel")}
            </p>
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
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-[var(--radix-popover-trigger-width)] rounded-md bg-card p-1.5"
            >
              <div className="mb-2 flex h-9 items-center gap-2 rounded-sm px-2.5 text-muted-foreground transition-colors hover:bg-muted/60">
                <Search className="size-3.5" />
                <input
                  type="search"
                  value={branchSearch}
                  onChange={(event) => setBranchSearch(event.target.value)}
                  placeholder={t("contextPanel.picker.search")}
                  className="chat-context-search-input min-w-0 flex-1 appearance-none border-0 bg-transparent text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus:border-transparent focus:outline-none focus:ring-0 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0"
                />
              </div>
              <div className="scrollbar-none max-h-64 overflow-y-auto">
                <button
                  type="button"
                  className={cn(optionClassName, "mb-1 text-foreground/70")}
                  disabled={disabled}
                  onClick={() => {
                    setCreateMode("branch");
                    setBranchOpen(false);
                  }}
                >
                  <Plus className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {t("contextPanel.picker.addBranch")}
                  </span>
                </button>
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
                        <Badge
                          variant="secondary"
                          className="max-w-28 truncate border-transparent bg-muted/70 px-1.5 py-0.5 text-muted-foreground"
                        >
                          {worktreeName(owningWorktree?.path ?? "")}
                        </Badge>
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
