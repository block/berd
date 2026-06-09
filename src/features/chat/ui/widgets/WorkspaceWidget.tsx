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
import { RowButton } from "@/shared/ui/row-button";
import { Spinner } from "@/shared/ui/spinner";
import type { ActiveWorkspace } from "../../stores/chatSessionStore";
import { Widget } from "./Widget";
import { WorkspaceActionsMenu } from "./WorkspaceActionsMenu";
import { WorkingContextPicker, shortenPath } from "./WorkingContextPicker";

interface WorkspaceWidgetProps {
  projectName?: string;
  projectColor?: string;
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

export function WorkspaceWidget({
  projectName,
  projectColor,
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
  isOpen,
  onToggleOpen,
  terminalOpen = false,
  onToggleTerminal,
}: WorkspaceWidgetProps) {
  const { t } = useTranslation("chat");
  const primaryWorkspaceRoot =
    activeContext?.path ?? sessionWorkingDir ?? projectWorkingDirs[0] ?? null;
  const isArtifactWorkspace = !projectName && projectWorkingDirs.length === 0;

  const gitErrorMessage =
    error instanceof Error ? error.message : t("contextPanel.errors.gitRead");

  return (
    <Widget
      title={t("contextPanel.widgets.workspace")}
      icon={<IconFolder className="size-3.5" />}
      isOpen={isOpen}
      onToggleOpen={onToggleOpen}
      action={
        <div className="flex items-center gap-1">
          {primaryWorkspaceRoot && onToggleTerminal ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onToggleTerminal}
              className="rounded-md"
              aria-pressed={terminalOpen}
              aria-label={
                terminalOpen ? t("terminal.toggle") : t("terminal.open")
              }
              title={terminalOpen ? t("terminal.toggle") : t("terminal.open")}
            >
              <IconTerminal2 className="size-3" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onRefresh}
            disabled={!primaryWorkspaceRoot || isFetching}
            className="rounded-md"
            aria-label={t("contextPanel.actions.refreshGitStatus")}
            title={t("contextPanel.actions.refreshGitStatus")}
          >
            {isFetching ? (
              <Spinner className="size-3" />
            ) : (
              <IconRefresh className="size-3" />
            )}
          </Button>
        </div>
      }
    >
      <div className="space-y-2.5">
        {projectName ? (
          <div className="flex items-center gap-2">
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={
                projectColor ? { backgroundColor: projectColor } : undefined
              }
            />
            <span className="truncate text-foreground">{projectName}</span>
          </div>
        ) : isArtifactWorkspace ? (
          <p className="text-foreground">
            {t("contextPanel.artifacts.workspaceLabel")}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t("contextPanel.empty.noProjectAssigned")}
          </p>
        )}

        {!primaryWorkspaceRoot ? (
          <p className="truncate">{t("contextPanel.empty.folderNotSet")}</p>
        ) : isLoading && !gitState ? (
          <div className="flex items-center gap-2 text-foreground">
            <Spinner className="size-4" />
            <span>{t("contextPanel.states.gitLoading")}</span>
          </div>
        ) : error ? (
          <p className="text-destructive">{gitErrorMessage}</p>
        ) : gitState?.isGitRepo ? (
          <div className="space-y-2">
            <WorkingContextPicker
              currentProjectPath={primaryWorkspaceRoot}
              gitState={gitState}
              activeContext={activeContext}
              onSelect={onContextChange}
              onSwitchBranch={onSwitchBranch}
              onStashAndSwitch={onStashAndSwitch}
              onChangeFolder={onChangeFolder}
              isChangingFolder={isChangingFolder}
            />
            <WorkspaceActionsMenu
              currentProjectPath={primaryWorkspaceRoot}
              gitState={gitState}
              activeContext={activeContext}
              disabled={isFetching}
              onContextChange={onContextChange}
              onFetch={onFetch}
              onPull={onPull}
              onCreateBranch={onCreateBranch}
              onCreateWorktree={onCreateWorktree}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <RowButton
              variant="field"
              onClick={() => void onChangeFolder?.()}
              disabled={!onChangeFolder || isChangingFolder}
              aria-label={t("contextPanel.folder.change")}
              icon={
                <IconFolder className="size-4 shrink-0 text-muted-foreground" />
              }
              label={shortenPath(primaryWorkspaceRoot)}
              description={
                isArtifactWorkspace
                  ? t("contextPanel.artifacts.folderLabel")
                  : t("contextPanel.folder.label")
              }
              trailing={
                isChangingFolder ? (
                  <Spinner className="size-3 shrink-0" />
                ) : onChangeFolder ? (
                  <IconReplace className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <IconFolderOpen className="size-4 shrink-0 text-muted-foreground" />
                )
              }
            />
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
    </Widget>
  );
}
