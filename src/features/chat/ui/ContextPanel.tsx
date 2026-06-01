import { useCallback, useState } from "react";
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
import { useChatSessionStore } from "../stores/chatSessionStore";
import type { ActiveWorkspace } from "../stores/chatSessionStore";
import { WorkspaceWidget } from "./widgets/WorkspaceWidget";
import { ChangesWidget } from "./widgets/ChangesWidget";
import { ArtifactsWidget } from "./widgets/ArtifactsWidget";
import { openPath } from "@tauri-apps/plugin-opener";
import { updateWorkingDir } from "@/shared/api/acpApi";
import { toast } from "sonner";
import { setArtifactRootPreference } from "@/shared/artifacts/sessionArtifactLocation";

interface ContextPanelProps {
  sessionId: string;
  projectName?: string;
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

export function ContextPanel({
  sessionId,
  projectName,
  projectColor,
  projectWorkingDirs = [],
  sessionWorkingDir,
  terminalOpen = false,
  onToggleTerminal,
}: ContextPanelProps) {
  const { t } = useTranslation("chat");
  const [activeTab, setActiveTab] = useState<ContextPanelTab>("details");
  const [isChangingArtifactFolder, setIsChangingArtifactFolder] =
    useState(false);
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
  const fileBrowserRoots =
    projectWorkingDirs.length > 0
      ? projectWorkingDirs
      : sessionWorkingDir
        ? [sessionWorkingDir]
        : [];
  const {
    data: gitState,
    error,
    isLoading,
    isFetching,
    refetch,
  } = useGitState(gitTargetPath, activeTab === "details");

  const {
    data: changedFiles,
    error: changedFilesError,
    isLoadingError: isChangedFilesLoadingError,
    isLoading: isFilesLoading,
    refetch: refetchFiles,
  } = useChangedFiles(gitTargetPath, activeTab === "details");
  const shouldShowChanges = gitState?.isGitRepo !== false;
  const shouldShowArtifacts = gitState?.isGitRepo === false;

  const handleContextChange = useCallback(
    (context: ActiveWorkspace) => {
      setActiveWorkspace(sessionId, context);
    },
    [sessionId, setActiveWorkspace],
  );

  const refetchAll = useCallback(async () => {
    await Promise.all([
      refetch().catch(() => undefined),
      refetchFiles().catch(() => undefined),
    ]);
  }, [refetch, refetchFiles]);

  const handleSwitchBranch = useCallback(
    async (path: string, branch: string) => {
      await switchBranch(path, branch);
      await refetchAll();
    },
    [refetchAll],
  );

  const handleStashAndSwitch = useCallback(
    async (path: string, branch: string) => {
      await stashChanges(path);
      await switchBranch(path, branch);
      await refetchAll();
    },
    [refetchAll],
  );

  const handleInitRepo = useCallback(
    async (path: string) => {
      await initRepo(path);
      await refetchAll();
    },
    [refetchAll],
  );

  const handleChangeArtifactFolder = useCallback(async () => {
    setIsChangingArtifactFolder(true);

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: gitTargetPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("contextPanel.artifacts.changeFolderDialogTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      await ensureDirectory(selected);
      await updateWorkingDir(sessionId, selected);
      setArtifactRootPreference(selected);
      patchSession(sessionId, { workingDir: selected });
      setActiveWorkspace(sessionId, { path: selected, branch: null });
      await refetchAll();
      toast.success(t("contextPanel.artifacts.changeFolderSuccess"));
    } catch (error) {
      console.warn("Failed to change artifact folder:", error);
      toast.error(t("contextPanel.errors.artifactFolderChange"));
    } finally {
      setIsChangingArtifactFolder(false);
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
      <div className="shrink-0 px-5 pb-2 pt-2.5">
        <TabsList variant="weight">
          <TabsTrigger value="details" variant="weight">
            {t("contextPanel.tabs.details")}
          </TabsTrigger>
          <TabsTrigger value="files" variant="weight">
            {t("contextPanel.tabs.files")}
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="mx-5 shrink-0 border-b border-border/80" aria-hidden />

      <TabsContent
        value="details"
        className="w-full min-h-0 flex-1 overflow-y-auto"
      >
        <div className="w-full pb-3">
          <WorkspaceWidget
            projectName={projectName}
            projectColor={projectColor}
            projectWorkingDirs={projectWorkingDirs}
            sessionWorkingDir={sessionWorkingDir}
            gitState={gitState}
            isLoading={isLoading}
            isFetching={isFetching}
            error={error}
            activeContext={activeContext}
            onContextChange={handleContextChange}
            onSwitchBranch={handleSwitchBranch}
            onStashAndSwitch={handleStashAndSwitch}
            onInitRepo={handleInitRepo}
            onChangeArtifactFolder={handleChangeArtifactFolder}
            onFetch={handleFetch}
            onPull={handlePull}
            onCreateBranch={handleCreateBranch}
            onCreateWorktree={handleCreateWorktree}
            onRefresh={handleRefresh}
            isChangingArtifactFolder={isChangingArtifactFolder}
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

      <TabsContent value="files" className="w-full overflow-y-auto">
        <FilesList projectWorkingDirs={fileBrowserRoots} />
      </TabsContent>
    </Tabs>
  );
}
