import { useTranslation } from "react-i18next";
import {
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconRefresh,
  IconReplace,
  IconTerminal2,
} from "@tabler/icons-react";
import type { CreatedWorktree, GitState } from "@/shared/types/git";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { cn } from "@/shared/lib/cn";
import type { ActiveWorkspace } from "../../stores/chatSessionStore";
import { WorkspaceActionsMenu } from "./WorkspaceActionsMenu";
import { WorkingContextPicker } from "./WorkingContextPicker";
import { shortenPath } from "./workspacePath";

interface LegacyWorkspaceWidgetProps {
  projectName?: string;
  projectWorkingDirs: string[];
  sessionWorkingDir?: string | null;
  gitState: GitState | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  activeContext: ActiveWorkspace | undefined;
  onContextChange: (context: ActiveWorkspace) => void;
  onSwitchBranch: (path: string, branch: string) => Promise<void>;
  onStashAndSwitch: (path: string, branch: string) => Promise<void>;
  onInitRepo: (path: string) => Promise<void>;
  onFetch: (path: string) => Promise<void>;
  onPull: (path: string) => Promise<void>;
  onChangeFolder?: () => Promise<void> | void;
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
  onRefresh: () => void;
  isChangingFolder?: boolean;
  isOpen: boolean;
  onToggleOpen: () => void;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
}

export function LegacyWorkspaceWidget({
  projectName,
  projectWorkingDirs,
  sessionWorkingDir,
  gitState,
  isLoading,
  isFetching,
  error,
  activeContext,
  onContextChange,
  onSwitchBranch,
  onStashAndSwitch,
  onInitRepo,
  onFetch,
  onPull,
  onChangeFolder,
  onCreateBranch,
  onCreateWorktree,
  onRefresh,
  isChangingFolder = false,
  onToggleTerminal,
}: LegacyWorkspaceWidgetProps) {
  const { t } = useTranslation("chat");
  const primaryWorkspaceRoot =
    activeContext?.path ?? sessionWorkingDir ?? projectWorkingDirs[0] ?? null;
  const isArtifactWorkspace = !projectName && projectWorkingDirs.length === 0;

  const gitErrorMessage =
    error instanceof Error ? error.message : t("contextPanel.errors.gitRead");

  return (
    <section className="w-full pb-2 text-sm font-normal">
      <div className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-normal text-muted-foreground">
              {t("contextPanel.widgets.workspace")}
            </p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onRefresh}
                disabled={!primaryWorkspaceRoot || isFetching}
                className="rounded-full"
                aria-label={t("contextPanel.actions.refreshLocalStatus")}
                tooltip={t("contextPanel.actions.refreshLocalStatus")}
              >
                {isFetching ? (
                  <Spinner className="size-4" />
                ) : (
                  <IconRefresh className="size-4" />
                )}
              </Button>
              {!gitState?.isGitRepo &&
              primaryWorkspaceRoot &&
              onToggleTerminal ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onToggleTerminal}
                  className="rounded-full"
                  aria-label={t("terminal.open")}
                  tooltip={t("terminal.open")}
                >
                  <IconTerminal2 className="size-4" />
                </Button>
              ) : null}
              {gitState?.isGitRepo && primaryWorkspaceRoot ? (
                <WorkspaceActionsMenu
                  currentProjectPath={primaryWorkspaceRoot}
                  gitState={gitState}
                  activeContext={activeContext}
                  disabled={isFetching}
                  onContextChange={onContextChange}
                  onToggleTerminal={onToggleTerminal}
                  onChangeFolder={onChangeFolder}
                  isChangingFolder={isChangingFolder}
                  onFetch={onFetch}
                  onPull={onPull}
                  onCreateWorktree={onCreateWorktree}
                />
              ) : null}
            </div>
          </div>

          {!primaryWorkspaceRoot ? (
            <p className="truncate rounded-sm bg-muted/60 px-4 py-3 text-muted-foreground">
              {t("contextPanel.empty.folderNotSet")}
            </p>
          ) : isLoading && !gitState ? (
            <div className="flex items-center gap-2 rounded-sm bg-muted/60 px-4 py-3 text-foreground">
              <Spinner className="size-4" />
              <span>{t("contextPanel.states.gitLoading")}</span>
            </div>
          ) : error ? (
            <p className="rounded-sm bg-muted/60 px-4 py-3 text-destructive">
              {gitErrorMessage}
            </p>
          ) : gitState?.isGitRepo ? (
            <WorkingContextPicker
              currentProjectPath={primaryWorkspaceRoot}
              gitState={gitState}
              activeContext={activeContext}
              onSelect={onContextChange}
              onSwitchBranch={onSwitchBranch}
              onStashAndSwitch={onStashAndSwitch}
              onCreateBranch={onCreateBranch}
            />
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void onChangeFolder?.()}
                disabled={!onChangeFolder || isChangingFolder}
                className={cn(
                  "flex w-full items-center gap-3 rounded-sm bg-muted/60 px-4 py-3",
                  "text-sm text-foreground transition-colors",
                  "hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-muted/60",
                )}
                aria-label={t("contextPanel.folder.change")}
              >
                <IconFolder className="size-4 shrink-0 text-foreground" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-foreground">
                    {shortenPath(primaryWorkspaceRoot)}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {isArtifactWorkspace
                      ? t("contextPanel.artifacts.folderLabel")
                      : t("contextPanel.folder.label")}
                  </span>
                </span>
                {isChangingFolder ? (
                  <Spinner className="size-4 shrink-0" />
                ) : onChangeFolder ? (
                  <IconReplace className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <IconFolderOpen className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
              {!isArtifactWorkspace ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void onInitRepo(primaryWorkspaceRoot)}
                  className="text-sm"
                >
                  <IconGitBranch className="size-4" />
                  {t("contextPanel.git.initRepo")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
