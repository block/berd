import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FilesList } from "./FilesList";
import { useGitState } from "@/shared/hooks/useGitState";
import { useChangedFiles } from "@/shared/hooks/useChangedFiles";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { ensureDirectory } from "@/shared/api/system";
import {
  createBranch,
  createWorktree,
  fetchRepo,
  initRepo,
  pullRepo,
  stashChanges,
  switchBranch,
} from "@/shared/api/git";
import type { CreatedWorktree } from "@/shared/types/git";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { SIDEBAR_NAV_TEXT_CLASS } from "@/shared/ui/sidebar-tokens";
import { useChatSessionStore } from "../stores/chatSessionStore";
import type { ActiveWorkspace } from "../stores/chatSessionStore";
import { WorkspaceWidget } from "./widgets/WorkspaceWidget";
import { formatErrorMessage } from "./widgets/formatError";
import { ChangesWidget } from "./widgets/ChangesWidget";
import { ArtifactsWidget } from "./widgets/ArtifactsWidget";
import { openPath } from "@tauri-apps/plugin-opener";
import { updateWorkingDir } from "@/shared/api/acpApi";
import { toast } from "sonner";

interface ContextPanelProps {
  sessionId: string;
  projectId?: string;
  projectName?: string;
  projectIcon?: string;
  projectColor?: string;
  projectWorkingDirs?: string[];
  sessionWorkingDir?: string | null;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
}

type ContextPanelTab = "details" | "files";
type ContextPanelSection = "workspace" | "changes" | "artifacts";
type ContextPanelSectionVisibility = Record<ContextPanelSection, boolean>;

const SECTION_VISIBILITY_STORAGE_KEY = "goose:context-panel:section-visibility";
const DEFAULT_SECTION_VISIBILITY: ContextPanelSectionVisibility = {
  workspace: true,
  changes: true,
  artifacts: true,
};

function validateSectionVisibility(
  value: unknown,
  defaults: ContextPanelSectionVisibility,
): ContextPanelSectionVisibility {
  if (!value || typeof value !== "object") return defaults;
  const parsed = value as Partial<Record<ContextPanelSection, unknown>>;
  return {
    workspace:
      typeof parsed.workspace === "boolean"
        ? parsed.workspace
        : defaults.workspace,
    changes:
      typeof parsed.changes === "boolean" ? parsed.changes : defaults.changes,
    artifacts:
      typeof parsed.artifacts === "boolean"
        ? parsed.artifacts
        : defaults.artifacts,
  };
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(paths.filter((path): path is string => Boolean(path))),
  );
}

export function ContextPanel({
  sessionId,
  projectId,
  projectName,
  projectIcon,
  projectColor,
  projectWorkingDirs = [],
  sessionWorkingDir,
  terminalOpen = false,
  onToggleTerminal,
}: ContextPanelProps) {
  const { t } = useTranslation("chat");
  const [activeTab, setActiveTab] = useState<ContextPanelTab>("details");
  const [isChangingFolder, setIsChangingFolder] = useState(false);
  const [sectionVisibility, setSectionVisibility] = usePersistedState(
    SECTION_VISIBILITY_STORAGE_KEY,
    DEFAULT_SECTION_VISIBILITY,
    validateSectionVisibility,
  );
  const projectDefaultWorkspaceRoot = projectWorkingDirs[0] ?? null;

  const activeContext = useChatSessionStore(
    (s) => s.activeWorkspaceBySession[sessionId],
  );
  const setActiveWorkspace = useChatSessionStore((s) => s.setActiveWorkspace);
  const patchSession = useChatSessionStore((s) => s.patchSession);

  const gitTargetPath =
    activeContext?.path ??
    sessionWorkingDir ??
    projectDefaultWorkspaceRoot ??
    null;
  const fileBrowserRoots = uniquePaths([gitTargetPath]);
  const queryClient = useQueryClient();
  const {
    data: gitState,
    error,
    isLoading,
    isFetching,
  } = useGitState(gitTargetPath, activeTab === "details");
  const shouldLoadFallbackGitState =
    activeTab === "details" &&
    Boolean(error) &&
    !gitState &&
    Boolean(projectDefaultWorkspaceRoot) &&
    Boolean(gitTargetPath) &&
    projectDefaultWorkspaceRoot !== gitTargetPath;
  const { data: fallbackGitState } = useGitState(
    projectDefaultWorkspaceRoot,
    shouldLoadFallbackGitState,
  );

  const {
    data: changedFiles,
    error: changedFilesError,
    isLoadingError: isChangedFilesLoadingError,
    isLoading: isFilesLoading,
  } = useChangedFiles(gitTargetPath, activeTab === "details");
  const shouldShowChanges = gitState?.isGitRepo !== false;
  const shouldShowArtifacts = gitState?.isGitRepo === false;

  const handleContextChange = useCallback(
    (context: ActiveWorkspace) => {
      setActiveWorkspace(sessionId, context);
    },
    [sessionId, setActiveWorkspace],
  );

  // Git mutations can move branches in any worktree of the repo, and the
  // routing decisions in the picker depend on that repo-wide picture, so
  // invalidate every cached path — not just the one this panel is showing.
  const refetchAll = useCallback(async () => {
    await Promise.all([
      queryClient
        .invalidateQueries({ queryKey: ["git-state"] })
        .catch(() => undefined),
      queryClient
        .invalidateQueries({ queryKey: ["changed-files"] })
        .catch(() => undefined),
    ]);
  }, [queryClient]);

  const handleSwitchBranch = useCallback(
    async (path: string, branch: string) => {
      try {
        await switchBranch(path, branch);
      } finally {
        // Re-sync even when git refuses the switch, so the picker reflects
        // reality without a manual refresh.
        await refetchAll();
      }
    },
    [refetchAll],
  );

  const handleStashAndSwitch = useCallback(
    async (path: string, branch: string) => {
      try {
        await stashChanges(path);
        try {
          await switchBranch(path, branch);
        } catch (error) {
          // The stash already succeeded: make sure the failure toast tells
          // the user their changes are parked in the stash, not lost.
          throw new Error(
            `${formatErrorMessage(
              error,
              t("contextPanel.picker.switchError", { branch }),
            )} ${t("contextPanel.picker.changesStashed")}`,
          );
        }
      } finally {
        await refetchAll();
      }
    },
    [refetchAll, t],
  );

  const handleInitRepo = useCallback(
    async (path: string) => {
      await initRepo(path);
      await refetchAll();
    },
    [refetchAll],
  );

  // Re-points the current chat only. The default folder for new general
  // chats lives in Settings and is intentionally not touched here.
  const handleChangeFolder = useCallback(async () => {
    setIsChangingFolder(true);

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: gitTargetPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("contextPanel.folder.changeDialogTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      await ensureDirectory(selected);
      await updateWorkingDir(sessionId, selected);
      patchSession(sessionId, { workingDir: selected });
      setActiveWorkspace(sessionId, { path: selected, branch: null });
      await refetchAll();
      toast.success(t("contextPanel.folder.changeSuccess"));
    } catch (error) {
      console.warn("Failed to change working folder:", error);
      toast.error(t("contextPanel.errors.folderChange"));
    } finally {
      setIsChangingFolder(false);
    }
  }, [
    gitTargetPath,
    patchSession,
    refetchAll,
    sessionId,
    setActiveWorkspace,
    t,
  ]);

  const handleFetch = useCallback(
    async (path: string) => {
      await fetchRepo(path);
      await refetchAll();
    },
    [refetchAll],
  );

  const handlePull = useCallback(
    async (path: string) => {
      await pullRepo(path);
      await refetchAll();
    },
    [refetchAll],
  );

  const handleCreateBranch = useCallback(
    async (path: string, name: string, baseBranch: string) => {
      await createBranch(path, name, baseBranch);
      await refetchAll();
    },
    [refetchAll],
  );

  const handleCreateWorktree = useCallback(
    async (
      path: string,
      name: string,
      branch: string,
      createBranchForWorktree: boolean,
      baseBranch?: string,
    ): Promise<CreatedWorktree> => {
      const createdWorktree = await createWorktree(
        path,
        name,
        branch,
        createBranchForWorktree,
        baseBranch,
      );
      await refetchAll();
      return createdWorktree;
    },
    [refetchAll],
  );

  const handleOpenChangedFile = useCallback(
    (filePath: string) => {
      if (!gitTargetPath) return;
      const fullPath = `${gitTargetPath}/${filePath}`;
      void openPath(fullPath);
    },
    [gitTargetPath],
  );

  const handleRefresh = useCallback(() => {
    void refetchAll();
  }, [refetchAll]);

  const toggleSection = useCallback(
    (section: ContextPanelSection) => {
      setSectionVisibility((prev) => ({
        ...prev,
        [section]: !prev[section],
      }));
    },
    [setSectionVisibility],
  );

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as ContextPanelTab)}
      className="flex w-full min-w-0 flex-col gap-0"
    >
      <div className="shrink-0 px-4 pb-2 pt-2.5">
        <TabsList variant="weight">
          <TabsTrigger
            value="details"
            variant="weight"
            className={SIDEBAR_NAV_TEXT_CLASS}
          >
            {t("contextPanel.tabs.details")}
          </TabsTrigger>
          <TabsTrigger
            value="files"
            variant="weight"
            className={SIDEBAR_NAV_TEXT_CLASS}
          >
            {t("contextPanel.tabs.files")}
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="mx-4 shrink-0 border-b border-border/80" aria-hidden />

      <TabsContent
        value="details"
        className="scrollbar-none w-full min-h-0 flex-1 overflow-y-auto"
      >
        <div className="w-full pb-4">
          <WorkspaceWidget
            projectId={projectId}
            projectName={projectName}
            projectIcon={projectIcon}
            projectColor={projectColor}
            projectWorkingDirs={projectWorkingDirs}
            sessionWorkingDir={sessionWorkingDir}
            gitState={gitState}
            fallbackGitState={fallbackGitState}
            isLoading={isLoading}
            isFetching={isFetching}
            error={error}
            activeContext={activeContext}
            onContextChange={handleContextChange}
            onSwitchBranch={handleSwitchBranch}
            onStashAndSwitch={handleStashAndSwitch}
            onInitRepo={handleInitRepo}
            onChangeFolder={handleChangeFolder}
            onFetch={handleFetch}
            onPull={handlePull}
            onCreateBranch={handleCreateBranch}
            onCreateWorktree={handleCreateWorktree}
            onRefresh={handleRefresh}
            isChangingFolder={isChangingFolder}
            isOpen={sectionVisibility.workspace}
            onToggleOpen={() => toggleSection("workspace")}
            terminalOpen={terminalOpen}
            onToggleTerminal={onToggleTerminal}
          />
          {shouldShowChanges && (
            <ChangesWidget
              files={changedFiles}
              isLoading={isFilesLoading}
              error={changedFilesError}
              isLoadingError={isChangedFilesLoadingError}
              currentBranch={gitState?.currentBranch ?? null}
              dirtyFileCount={gitState?.dirtyFileCount ?? 0}
              repoPath={gitTargetPath ?? ""}
              onOpenFile={handleOpenChangedFile}
              isOpen={sectionVisibility.changes}
              onToggleOpen={() => toggleSection("changes")}
            />
          )}
          {shouldShowArtifacts && (
            <ArtifactsWidget
              isOpen={sectionVisibility.artifacts}
              onToggleOpen={() => toggleSection("artifacts")}
            />
          )}
        </div>
      </TabsContent>

      <TabsContent
        value="files"
        className="scrollbar-none w-full overflow-y-auto"
      >
        <FilesList projectWorkingDirs={fileBrowserRoots} />
      </TabsContent>
    </Tabs>
  );
}
