import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { FileContextMenu } from "@/shared/ui/file-context-menu";
import { Skeleton } from "@/shared/ui/skeleton";
import type { ChangedFile } from "@/shared/types/git";
import type { WorkspaceChangedFilesRuntime } from "../hooks/useWorkspaceGitRuntimes";

/** Placeholder rows shared by the widgets and the tab-level loading branch.
 *  Padding is the caller's job: the widgets already sit in a padded
 *  `<section>`, while the tab renders these directly. */
function ChangesSkeletonRows() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

/** Text-only empty message for use inside the widgets' padded `<section>`,
 *  where the surrounding layout already owns spacing and alignment. */
function ChangesEmptyMessage({ message }: { message?: string }) {
  const { t } = useTranslation("chat");

  return (
    <p className="text-sm text-muted-foreground">
      {message ?? t("contextPanel.empty.noChanges")}
    </p>
  );
}

/** Tab-level states. Shared spacing comes from the tab content wrapper; these
 *  only own their centered state layout. */
export function ChangesEmptyState({ message }: { message?: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-center">
      <ChangesEmptyMessage message={message} />
    </div>
  );
}

export function ChangesErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-center">
      <p className="text-sm text-destructive">{message}</p>
    </div>
  );
}

export function ChangesLoadingState() {
  return (
    <div>
      <ChangesSkeletonRows />
    </div>
  );
}

function splitPath(relativePath: string) {
  const lastSlash = relativePath.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", name: relativePath };
  return {
    dir: relativePath.slice(0, lastSlash + 1),
    name: relativePath.slice(lastSlash + 1),
  };
}

function renderChangeSummary(summary: string, count: number) {
  const countText = String(count);
  const countIndex = summary.indexOf(countText);

  if (countIndex === -1) return summary;

  return (
    <>
      {summary.slice(0, countIndex)}
      <span className="text-foreground">{countText}</span>
      {summary.slice(countIndex + countText.length)}
    </>
  );
}

function ChangedFileRow({
  file,
  fullPath,
  onOpen,
}: {
  file: ChangedFile;
  fullPath: string;
  onOpen: (path: string) => void;
}) {
  const { dir, name } = splitPath(file.path);
  const isDeleted = file.status === "deleted";

  const row = (
    <button
      type="button"
      disabled={isDeleted}
      className={cn(
        "group flex min-h-9 w-full select-none items-center gap-2 rounded-sm px-2.5 py-2 text-left transition-colors duration-100",
        isDeleted
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
      )}
      onClick={isDeleted ? undefined : () => onOpen(file.path)}
    >
      <div
        className={cn("min-w-0 flex-1 truncate", isDeleted && "line-through")}
      >
        <span className="truncate text-sm font-normal leading-[18px] text-foreground">
          {dir}
          {name}
        </span>
      </div>
      {!isDeleted ? (
        <ExternalLink
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      ) : null}
    </button>
  );

  if (isDeleted) return row;

  return <FileContextMenu path={fullPath}>{row}</FileContextMenu>;
}

function ChangedFilesList({
  files,
  getFullPath,
  onOpen,
}: {
  files: ChangedFile[];
  getFullPath: (file: ChangedFile) => string;
  onOpen: (path: string) => void;
}) {
  const [scrolled, setScrolled] = useState(false);

  return (
    <div
      // Scrolled rows fade under a top mask like the picker dropdown lists
      // (`chat-context-dropdown-results-scroll`); the -webkit- duplicate is
      // for WKWebView.
      className={cn(
        "scrollbar-none max-h-[300px] space-y-0.5 overflow-y-auto",
        scrolled &&
          "[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)] [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
      )}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
    >
      {files.map((file) => (
        <ChangedFileRow
          key={file.path}
          file={file}
          fullPath={getFullPath(file)}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

interface ChangesWidgetProps {
  files: ChangedFile[] | undefined;
  isLoading: boolean;
  error: Error | null;
  isLoadingError: boolean;
  currentBranch: string | null;
  dirtyFileCount: number;
  repoPath: string;
  onOpenFile: (path: string) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}

export function ChangesWidget({
  files,
  isLoading,
  error,
  isLoadingError,
  currentBranch,
  dirtyFileCount,
  repoPath,
  onOpenFile,
}: ChangesWidgetProps) {
  const { t } = useTranslation("chat");

  const totals = useMemo(() => {
    if (!files?.length) return { additions: 0, deletions: 0 };
    return files.reduce(
      (acc, f) => ({
        additions: acc.additions + f.additions,
        deletions: acc.deletions + f.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
  }, [files]);

  const changeCount = Math.max(files?.length ?? 0, dirtyFileCount);
  const hasChanges = changeCount > 0;
  const errorMessage =
    error instanceof Error
      ? error.message
      : t("contextPanel.errors.gitChangesRead");

  return (
    <section className="w-full text-sm font-normal">
      {isLoading && !files ? (
        <ChangesSkeletonRows />
      ) : error && isLoadingError ? (
        <p className="text-sm text-destructive">{errorMessage}</p>
      ) : hasChanges ? (
        <div className="space-y-2">
          <div className="flex h-6 min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {renderChangeSummary(
                t("contextPanel.summary.changes", { count: changeCount }),
                changeCount,
              )}
              {currentBranch ? (
                <>
                  {" "}
                  {t("contextPanel.widgets.changesOnBranch")}{" "}
                  <span className="text-foreground">{currentBranch}</span>
                </>
              ) : null}
            </span>
            {(totals.additions > 0 || totals.deletions > 0) && (
              <span className="shrink-0 font-mono text-sm tabular-nums">
                {totals.additions > 0 ? (
                  <span className="text-success">+{totals.additions}</span>
                ) : null}
                {totals.additions > 0 && totals.deletions > 0 ? " " : null}
                {totals.deletions > 0 ? (
                  <span className="text-status-deleted">
                    {/* i18n-check-ignore — mathematical symbol, not translatable */}
                    &minus;{totals.deletions}
                  </span>
                ) : null}
              </span>
            )}
          </div>
          {files?.length ? (
            <ChangedFilesList
              files={files}
              getFullPath={(file) => `${repoPath}/${file.path}`}
              onOpen={onOpenFile}
            />
          ) : null}
        </div>
      ) : (
        <ChangesEmptyMessage />
      )}
    </section>
  );
}

interface WorkspaceChangesWidgetProps {
  groups: WorkspaceChangedFilesRuntime[];
  onOpenFile: (path: string) => void;
  /** Git-state probe failure from a workspace that produced no changed-files
   *  runtime. Shown as a non-blocking notice above the groups: a sibling
   *  workspace's failure must not hide the changes we did resolve, but it also
   *  must not read as "no changes" for the workspace that failed. */
  probeErrorMessage?: string | null;
}

export function WorkspaceChangesWidget({
  groups,
  onOpenFile,
  probeErrorMessage = null,
}: WorkspaceChangesWidgetProps) {
  const { t } = useTranslation("chat");
  const isLoading = groups.some((group) => group.isLoading && !group.files);
  const firstLoadingError = groups.find(
    (group) => group.error && group.isLoadingError,
  );
  const changedGroups = groups
    .map((group) => {
      const files = group.files ?? [];
      const totals = files.reduce(
        (acc, file) => ({
          additions: acc.additions + file.additions,
          deletions: acc.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
      const changeCount = Math.max(files.length, group.dirtyFileCount);
      return {
        ...group,
        files,
        totals,
        changeCount,
      };
    })
    .filter((group) => group.changeCount > 0);
  const hasMultipleGroups = groups.length > 1;
  const errorMessage =
    firstLoadingError?.error instanceof Error
      ? firstLoadingError.error.message
      : t("contextPanel.errors.gitChangesRead");

  return (
    <section className="w-full text-sm font-normal">
      {isLoading && changedGroups.length === 0 ? (
        <ChangesSkeletonRows />
      ) : firstLoadingError ? (
        <p className="text-sm text-destructive">{errorMessage}</p>
      ) : changedGroups.length > 0 ? (
        <div className="space-y-4">
          {probeErrorMessage ? (
            <p className="text-sm text-destructive">{probeErrorMessage}</p>
          ) : null}
          {changedGroups.map((group) => (
            <div key={group.id} className="space-y-2">
              {hasMultipleGroups ? (
                <p className="truncate text-xs text-muted-foreground">
                  {group.workspaceTitle}
                </p>
              ) : null}
              <div className="flex h-6 min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {renderChangeSummary(
                    t("contextPanel.summary.changes", {
                      count: group.changeCount,
                    }),
                    group.changeCount,
                  )}
                  {group.currentBranch ? (
                    <>
                      {" "}
                      {t("contextPanel.widgets.changesOnBranch")}{" "}
                      <span className="text-foreground">
                        {group.currentBranch}
                      </span>
                    </>
                  ) : null}
                </span>
                {(group.totals.additions > 0 || group.totals.deletions > 0) && (
                  <span className="shrink-0 font-mono text-sm tabular-nums">
                    {group.totals.additions > 0 ? (
                      <span className="text-success">
                        +{group.totals.additions}
                      </span>
                    ) : null}
                    {group.totals.additions > 0 && group.totals.deletions > 0
                      ? " "
                      : null}
                    {group.totals.deletions > 0 ? (
                      <span className="text-status-deleted">
                        {/* i18n-check-ignore — mathematical symbol, not translatable */}
                        &minus;{group.totals.deletions}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
              {group.files.length > 0 ? (
                <ChangedFilesList
                  files={group.files}
                  getFullPath={(file) => `${group.repoPath}/${file.path}`}
                  onOpen={(path) => onOpenFile(`${group.repoPath}/${path}`)}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <ChangesEmptyMessage />
      )}
    </section>
  );
}
