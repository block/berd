import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconExternalLink, IconFile, IconGitBranch } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { FileContextMenu } from "@/shared/ui/file-context-menu";
import { Skeleton } from "@/shared/ui/skeleton";
import type { ChangedFile } from "@/shared/types/git";

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
        "group flex w-full select-none items-center gap-3 rounded-sm bg-muted/60 px-3.5 py-2.5 text-left",
        isDeleted ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
      onClick={isDeleted ? undefined : () => onOpen(file.path)}
    >
      <IconFile className="size-4 shrink-0 text-foreground" />
      <div
        className={cn("min-w-0 flex-1 truncate", isDeleted && "line-through")}
      >
        <span className="truncate text-sm font-normal text-foreground">
          {dir}
          {name}
        </span>
      </div>
      {!isDeleted ? (
        <IconExternalLink
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      ) : null}
    </button>
  );

  if (isDeleted) return row;

  return <FileContextMenu path={fullPath}>{row}</FileContextMenu>;
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
    <section className="w-full px-4 pt-4 text-sm font-normal">
      {isLoading && !files ? (
        <div className="space-y-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : error && isLoadingError ? (
        <p className="text-sm text-destructive">{errorMessage}</p>
      ) : hasChanges ? (
        <div className="space-y-3">
          <div className="flex min-w-0 items-center gap-3">
            <IconGitBranch className="size-4 shrink-0 text-foreground" />
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
                  <span className="text-destructive">
                    {/* i18n-check-ignore — mathematical symbol, not translatable */}
                    &minus;{totals.deletions}
                  </span>
                ) : null}
              </span>
            )}
          </div>
          {files?.length ? (
            <div className="max-h-[300px] space-y-2 overflow-y-auto">
              {files.map((file) => (
                <ChangedFileRow
                  key={file.path}
                  file={file}
                  fullPath={`${repoPath}/${file.path}`}
                  onOpen={onOpenFile}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("contextPanel.empty.noChanges")}
        </p>
      )}
    </section>
  );
}
