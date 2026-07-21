import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronDown,
  IconMessageCircle,
  IconPencil,
  IconRefresh,
  IconPlus,
  IconUpload,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { PageHeaderButton } from "@/shared/ui/page-header-button";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { PageShell } from "@/shared/ui/page-shell";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Spinner } from "@/shared/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { useSkillImportExport } from "../hooks/useSkillImportExport";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsDialogs } from "./SkillsDialogs";
import { skillsGridClass, SkillsGrid } from "./SkillsGrid";
import { hydrateProjectNames } from "../lib/projectHydration";
import { listenSkillsChanged } from "../lib/skillsEvents";
import { SkillDiscoveryView } from "./SkillDiscoveryView";
import { RemoteSkillDetailPage } from "./RemoteSkillDetailPage";
import { useRemoteSkills } from "../hooks/useRemoteSkills";
import type { RemoteSkill } from "../api/skillMarketplace";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { SKILL_DISCOVERY_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import type { AppNavigationUpdateOptions } from "@/app/types/appNavigation";
import {
  deleteSkill,
  listSkills,
  type EditingSkill,
  type SkillInfo,
} from "../api/skills";

interface SkillsViewProps {
  activeSkillId?: string | null;
  onActiveSkillIdChange?: (
    skillId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onBreadcrumbLabelChange?: (label: string | null) => void;
  onStartChatWithSkill?: (skill: SkillInfo, projectId?: string | null) => void;
}

type SkillScope = "all" | "global" | `project:${string}`;

// Discovered (remote) skills reuse the installed-skill active-id navigation
// channel so the top-bar breadcrumb handles back navigation. This prefix keeps
// their ids from ever colliding with real installed-skill ids.
const REMOTE_SKILL_PREFIX = "remote:";

const SKILL_BUILDER_SKILL: SkillInfo = {
  id: "builtin:skill-builder",
  name: "skill-builder",
  description:
    "Create, edit, or inspect Berd skills stored as skill folders with SKILL.md files.",
  instructions: "",
  path: "builtin://skills/skill-builder",
  fileLocation: "builtin://skills/skill-builder",
  sourceKind: "builtin",
  sourceLabel: "Built in",
  projectLinks: [],
  readonly: true,
  color: null,
};

function skillMatchesQuery(skill: SkillInfo, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return [
    skill.name,
    skill.description,
    skill.sourceLabel,
    ...skill.projectLinks.map((project) => project.name),
  ].some((field) => field.toLowerCase().includes(normalizedQuery));
}

function skillMatchesScope(skill: SkillInfo, scope: SkillScope): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "global") {
    return skill.sourceKind !== "project";
  }

  const projectId = scope.replace(/^project:/, "");
  return skill.projectLinks.some((project) => project.id === projectId);
}

function getPrimaryProjectLink(skill: SkillInfo) {
  return skill.projectLinks[0] ?? null;
}

function getProjectLinkForScope(
  skill: SkillInfo,
  selectedProjectId: string | null,
) {
  if (!selectedProjectId) {
    return getPrimaryProjectLink(skill);
  }

  return (
    skill.projectLinks.find((project) => project.id === selectedProjectId) ??
    getPrimaryProjectLink(skill)
  );
}

function resolveSkillForProjectScope(
  skill: SkillInfo,
  selectedProjectId: string | null,
): SkillInfo {
  if (skill.sourceKind !== "project") {
    return skill;
  }

  const projectLink = getProjectLinkForScope(skill, selectedProjectId);
  if (!projectLink) {
    return skill;
  }

  return {
    ...skill,
    path: projectLink.path,
    fileLocation: projectLink.fileLocation,
    sourceLabel: projectLink.name,
  };
}

function resolveSkillForPath(skill: SkillInfo, path: string): SkillInfo {
  if (skill.sourceKind !== "project") {
    return skill;
  }

  const projectLink = skill.projectLinks.find(
    (project) => project.path === path,
  );
  if (!projectLink) {
    return skill;
  }

  return {
    ...skill,
    path: projectLink.path,
    fileLocation: projectLink.fileLocation,
    sourceLabel: projectLink.name,
  };
}

export function SkillsView({
  activeSkillId,
  onActiveSkillIdChange,
  onBreadcrumbLabelChange,
  onStartChatWithSkill,
}: SkillsViewProps) {
  const { t } = useTranslation(["skills", "common"]);
  const projects = useProjectStore(selectProjects);
  const isActiveSkillControlled = activeSkillId !== undefined;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<EditingSkill | undefined>(
    undefined,
  );
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingSkill, setDeletingSkill] = useState<SkillInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [skillScope, setSkillScope] = useState<SkillScope>("all");
  const [viewMode, setViewMode] = useState<"installed" | "discover">(
    "installed",
  );
  // Skill discovery is an opt-in experiment: when off, the Discover tab, its
  // hook, and the remote detail route are all inert and only installed skills
  // render.
  const discoveryEnabled =
    useExperiment(SKILL_DISCOVERY_EXPERIMENT_ID)?.enabled === true;
  // Discovered skills navigate through the same active-skill channel as
  // installed skills (with a `remote:` prefix) so the top-bar breadcrumb owns
  // back navigation — no bespoke on-page back control, matching the installed
  // detail page. `selectedRemoteSkill` caches the picked object so the detail
  // renders instantly even before the catalog refetches.
  const [selectedRemoteSkill, setSelectedRemoteSkill] =
    useState<RemoteSkill | null>(null);
  const [internalActiveSkillId, setInternalActiveSkillId] = useState<
    string | null
  >(null);
  const loadRequestIdRef = useRef(0);
  const currentActiveSkillId = isActiveSkillControlled
    ? activeSkillId
    : internalActiveSkillId;
  const remoteSkillName =
    discoveryEnabled && currentActiveSkillId?.startsWith(REMOTE_SKILL_PREFIX)
      ? currentActiveSkillId.slice(REMOTE_SKILL_PREFIX.length)
      : null;
  // Load the catalog whenever Discover is open OR a remote detail route is
  // active (which can happen after a remount via app Back/Forward, when
  // viewMode has reset to "installed" but the `remote:` id persists), so the
  // detail resolves by name instead of falling through to the grid.
  const remote = useRemoteSkills(
    discoveryEnabled && (viewMode === "discover" || remoteSkillName !== null),
  );

  const setActiveSkill = useCallback(
    (skillId: string | null, options?: AppNavigationUpdateOptions) => {
      if (!isActiveSkillControlled) {
        setInternalActiveSkillId(skillId);
      }
      onActiveSkillIdChange?.(skillId, options);
    },
    [isActiveSkillControlled, onActiveSkillIdChange],
  );

  const loadSkills = useCallback(async (): Promise<SkillInfo[]> => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setLoading(true);

    try {
      const projectDirs = projects.flatMap((project) => project.workingDirs);
      const result = await listSkills(projectDirs);
      if (loadRequestIdRef.current !== requestId) {
        return [];
      }
      const nextSkills = hydrateProjectNames(result, projects);
      setSkills(nextSkills);
      return nextSkills;
    } catch (error) {
      if (loadRequestIdRef.current === requestId) {
        setSkills([]);
        toast.error(formatAcpErrorMessage(error, t("view.loadError")));
      }
      return [];
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [projects, t]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    return listenSkillsChanged(() => {
      void loadSkills();
    });
  }, [loadSkills]);

  const projectsWithSkillDirs = useMemo(
    () => projects.filter((project) => project.workingDirs.length > 0),
    [projects],
  );

  useEffect(() => {
    if (!skillScope.startsWith("project:")) {
      return;
    }
    const selectedProjectId = skillScope.replace(/^project:/, "");
    if (
      !projectsWithSkillDirs.some((project) => project.id === selectedProjectId)
    ) {
      setSkillScope("all");
    }
  }, [projectsWithSkillDirs, skillScope]);

  const activeSkill = remoteSkillName
    ? null
    : (skills.find((skill) => skill.id === currentActiveSkillId) ?? null);

  // Resolve the active remote skill from the (possibly refreshed) catalog,
  // falling back to the cached pick so the detail renders before the catalog
  // finishes loading.
  const activeRemoteSkill = remoteSkillName
    ? (remote.skills.find((skill) => skill.name === remoteSkillName) ??
      (remote.catalogState !== "ready" &&
      remote.catalogState !== "error" &&
      selectedRemoteSkill?.name === remoteSkillName
        ? selectedRemoteSkill
        : null))
    : null;

  useEffect(() => {
    onBreadcrumbLabelChange?.(
      activeRemoteSkill?.name ?? activeSkill?.name ?? null,
    );
  }, [activeSkill?.name, onBreadcrumbLabelChange, activeRemoteSkill?.name]);

  useEffect(() => {
    return () => onBreadcrumbLabelChange?.(null);
  }, [onBreadcrumbLabelChange]);

  const visibleSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skillMatchesScope(skill, skillScope) &&
          skillMatchesQuery(skill, searchQuery),
      ),
    [searchQuery, skillScope, skills],
  );

  const selectedProjectId = skillScope.startsWith("project:")
    ? skillScope.replace(/^project:/, "")
    : null;
  // When a project scope is selected (the scope selector is visible on both
  // tabs), install discovered skills into that project (`--project`) so they
  // land in the project-scoped Installed tab; otherwise installs go global.
  const selectedProjectScopeDir = useMemo(() => {
    if (!selectedProjectId) {
      return null;
    }
    return (
      projects.find((project) => project.id === selectedProjectId)
        ?.workingDirs[0] ?? null
    );
  }, [projects, selectedProjectId]);
  const resolveSkillForSelectedScope = useCallback(
    (skill: SkillInfo) => resolveSkillForProjectScope(skill, selectedProjectId),
    [selectedProjectId],
  );

  const selectedScopeLabel = useMemo(() => {
    if (selectedProjectId) {
      return (
        projects.find((project) => project.id === selectedProjectId)?.name ??
        t("view.scope.project")
      );
    }
    if (skillScope === "global") {
      return t("view.scope.global");
    }
    return t("view.scope.all");
  }, [projects, selectedProjectId, skillScope, t]);

  useEffect(() => {
    if (currentActiveSkillId && !remoteSkillName && !loading && !activeSkill) {
      setActiveSkill(null, { replace: true });
    }
  }, [
    activeSkill,
    currentActiveSkillId,
    loading,
    remoteSkillName,
    setActiveSkill,
  ]);

  // Companion guard for remote routes: if a `remote:` route is active but the
  // skill can't be resolved once the catalog has finished loading (removed
  // upstream, team-scope mismatch, or a failed load), clear the stale route so
  // the user lands on the grid instead of a route that can never render.
  useEffect(() => {
    if (
      remoteSkillName &&
      remote.catalogState === "ready" &&
      remote.cliState === "available" &&
      !activeRemoteSkill
    ) {
      setActiveSkill(null, { replace: true });
    }
  }, [
    remoteSkillName,
    remote.cliState,
    remote.catalogState,
    activeRemoteSkill,
    setActiveSkill,
  ]);

  const handleDelete = (skill: SkillInfo) => {
    const scopedSkill = resolveSkillForSelectedScope(skill);
    if (scopedSkill.readonly) {
      return;
    }
    setDeletingSkill(scopedSkill);
  };

  const handleConfirmDeleteSkill = async () => {
    const skillToDelete = deletingSkill;
    if (!skillToDelete) return;
    if (skillToDelete.readonly) {
      setDeletingSkill(null);
      return;
    }
    try {
      await deleteSkill(skillToDelete.path);
      setSkills((current) =>
        current.flatMap((skill) => {
          if (
            skill.sourceKind === "project" &&
            skill.id === skillToDelete.id &&
            skill.projectLinks.length > 1
          ) {
            const projectLinks = skill.projectLinks.filter(
              (project) => project.path !== skillToDelete.path,
            );
            if (projectLinks.length === skill.projectLinks.length) {
              return [skill];
            }
            if (projectLinks.length === 0) {
              return [];
            }

            return [
              {
                ...skill,
                path: projectLinks[0].path,
                fileLocation: projectLinks[0].fileLocation,
                sourceLabel: projectLinks[0].name,
                projectLinks,
              },
            ];
          }

          return skill.id !== skillToDelete.id &&
            skill.path !== skillToDelete.path
            ? [skill]
            : [];
        }),
      );
      if (currentActiveSkillId === skillToDelete.id) {
        setActiveSkill(null, { replace: true });
      }
      toast.success(t("view.deleteSuccess", { name: skillToDelete.name }));
    } catch (error) {
      toast.error(formatAcpErrorMessage(error, t("view.deleteError")));
    }
    setDeletingSkill(null);
  };

  const handleEdit = (skill: SkillInfo) => {
    const scopedSkill = resolveSkillForSelectedScope(skill);
    if (scopedSkill.readonly) {
      return;
    }
    setEditingSkill({
      name: scopedSkill.name,
      description: scopedSkill.description,
      instructions: scopedSkill.instructions,
      path: scopedSkill.path,
      fileLocation: scopedSkill.fileLocation,
      color: scopedSkill.color,
    });
    setDialogOpen(true);
  };

  const handleReveal = useCallback(
    (skill: SkillInfo) => {
      const scopedSkill = resolveSkillForSelectedScope(skill);
      if (scopedSkill.readonly) {
        return;
      }
      void revealInFileManager(scopedSkill.path);
    },
    [resolveSkillForSelectedScope],
  );

  const handleStartChat = useCallback(
    (skill: SkillInfo) => {
      const scopedSkill = resolveSkillForSelectedScope(skill);
      const projectId =
        getProjectLinkForScope(scopedSkill, selectedProjectId)?.id ?? null;
      onStartChatWithSkill?.(scopedSkill, projectId);
    },
    [onStartChatWithSkill, resolveSkillForSelectedScope, selectedProjectId],
  );

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingSkill(undefined);
  };

  // Wire Delete from inside the SkillEditor footer: close the editor sheet,
  // then surface the existing AlertDialog delete confirmation.
  const handleDeleteFromEditor = useCallback(
    (editing: EditingSkill) => {
      const match = skills.find(
        (skill) =>
          skill.path === editing.path ||
          skill.projectLinks.some((project) => project.path === editing.path),
      );
      setDialogOpen(false);
      setEditingSkill(undefined);
      if (match) {
        setDeletingSkill(resolveSkillForPath(match, editing.path));
      }
    },
    [skills],
  );

  const handleNewSkill = useCallback(() => {
    setEditingSkill(undefined);
    setDialogOpen(true);
  }, []);

  const handleNewSkillWithChat = useCallback(() => {
    onStartChatWithSkill?.(SKILL_BUILDER_SKILL, selectedProjectId);
  }, [onStartChatWithSkill, selectedProjectId]);

  const handleSkillSaved = useCallback(
    (savedSkill?: SkillInfo) => {
      if (!savedSkill) {
        return;
      }

      const previousPath = editingSkill?.path;
      setSkills((current) => {
        const existingIndex = current.findIndex(
          (skill) =>
            skill.id === savedSkill.id ||
            skill.path === savedSkill.path ||
            skill.projectLinks.some(
              (project) => project.path === savedSkill.path,
            ) ||
            (previousPath ? skill.path === previousPath : false),
        );
        if (existingIndex === -1) {
          return [...current, savedSkill];
        }

        const next = [...current];
        next[existingIndex] = savedSkill;
        return next;
      });
      setActiveSkill(savedSkill.id);
    },
    [editingSkill?.path, setActiveSkill],
  );

  const { fileInputRef, handleFileChange, openFilePicker, handleExport } =
    useSkillImportExport();

  const setTopBarActions = useSetTopBarActions();

  useEffect(() => {
    if (activeSkill || remoteSkillName) {
      setTopBarActions(null);
      return;
    }
    setTopBarActions(
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PageHeaderButton
              type="button"
              aria-label={t("view.scope.ariaLabel")}
              rightIcon={<IconChevronDown />}
            >
              {selectedScopeLabel}
            </PageHeaderButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className={skillScope === "all" ? "bg-muted" : undefined}
              onSelect={() => setSkillScope("all")}
            >
              {t("view.scope.all")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={skillScope === "global" ? "bg-muted" : undefined}
              onSelect={() => setSkillScope("global")}
            >
              {t("view.scope.global")}
            </DropdownMenuItem>
            {projectsWithSkillDirs.length > 0 ? (
              <DropdownMenuLabel className="pt-2 text-xs text-muted-foreground">
                {t("view.scope.projects")}
              </DropdownMenuLabel>
            ) : null}
            {projectsWithSkillDirs.map((project) => (
              <DropdownMenuItem
                key={project.id}
                className={
                  skillScope === `project:${project.id}`
                    ? "bg-muted"
                    : undefined
                }
                onSelect={() => setSkillScope(`project:${project.id}`)}
              >
                {project.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <PageHeaderButton
          type="button"
          onClick={openFilePicker}
          leftIcon={<IconUpload />}
        >
          {t("common:actions.import")}
        </PageHeaderButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PageHeaderButton type="button" leftIcon={<IconPlus />}>
              {t("view.newSkill")}
            </PageHeaderButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={handleNewSkillWithChat}>
              <IconMessageCircle />
              {t("view.createWithChat")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleNewSkill}>
              <IconPencil />
              {t("view.createManually")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    return () => setTopBarActions(null);
  }, [
    activeSkill,
    handleNewSkill,
    handleNewSkillWithChat,
    openFilePicker,
    projectsWithSkillDirs,
    remoteSkillName,
    selectedScopeLabel,
    setTopBarActions,
    skillScope,
    t,
  ]);

  const handleShare = useCallback(
    (skill: SkillInfo) => {
      const scopedSkill = resolveSkillForSelectedScope(skill);
      if (scopedSkill.readonly) {
        return;
      }
      void handleExport(scopedSkill);
    },
    [handleExport, resolveSkillForSelectedScope],
  );

  const handleSelectSkill = (skill: SkillInfo) => {
    setActiveSkill(skill.id);
  };

  const handleSelectRemoteSkill = useCallback(
    (skill: RemoteSkill) => {
      setSelectedRemoteSkill(skill);
      setActiveSkill(`${REMOTE_SKILL_PREFIX}${skill.name}`);
    },
    [setActiveSkill],
  );

  const dialogs = (
    <SkillsDialogs
      dialogOpen={dialogOpen}
      onDialogClose={handleDialogClose}
      onSaved={handleSkillSaved}
      editingSkill={editingSkill}
      initialProjectId={selectedProjectId}
      deletingSkill={deletingSkill}
      onDeletingSkillChange={setDeletingSkill}
      onConfirmDelete={handleConfirmDeleteSkill}
      onDeleteFromEditor={handleDeleteFromEditor}
    />
  );

  if (activeRemoteSkill) {
    return (
      <PageShell contentWidth="full">
        <RemoteSkillDetailPage
          skill={activeRemoteSkill}
          installing={remote.installing.has(activeRemoteSkill.name)}
          onInstall={(skill) =>
            void remote.install(skill, {
              projectDir: selectedProjectScopeDir,
              destinationLabel: selectedProjectScopeDir
                ? `${selectedScopeLabel} (${selectedProjectScopeDir})`
                : null,
            })
          }
        />
      </PageShell>
    );
  }

  // A remote route is active but the skill hasn't resolved yet because the
  // catalog is still loading (e.g. restored via app Back/Forward after a
  // remount). Show a loading or retry state instead of flashing the installed
  // grid until the skill resolves.
  if (remoteSkillName) {
    return (
      <PageShell contentWidth="full">
        {remote.catalogState === "error" ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm font-medium">{t("discover.loadError")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void remote.reload()}
              leftIcon={<IconRefresh />}
            >
              {t("discover.retry")}
            </Button>
          </div>
        ) : (
          <div
            role="status"
            aria-label={t("common:loading")}
            className="flex min-h-[60vh] items-center justify-center"
          >
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}
      </PageShell>
    );
  }

  if (activeSkill) {
    const scopedActiveSkill = resolveSkillForSelectedScope(activeSkill);
    return (
      <>
        <SkillDetailPage
          skill={scopedActiveSkill}
          onEdit={handleEdit}
          onReveal={handleReveal}
          onShare={handleShare}
          onStartChat={onStartChatWithSkill ? handleStartChat : undefined}
          onDelete={handleDelete}
        />
        {dialogs}
      </>
    );
  }

  return (
    <PageShell contentWidth="full">
      <section
        aria-labelledby="skills-heading"
        className="flex flex-col gap-10"
      >
        <div className={skillsGridClass}>
          <div className="col-span-full flex flex-col gap-4 sm:col-span-2">
            <SearchBar
              size="pill"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t("view.searchPlaceholder")}
              aria-label={t("view.searchAriaLabel")}
            />
            {discoveryEnabled ? (
              <Tabs
                value={viewMode}
                onValueChange={(value) => {
                  setViewMode(value as "installed" | "discover");
                  setSelectedRemoteSkill(null);
                  if (remoteSkillName) {
                    setActiveSkill(null, { replace: true });
                  }
                }}
              >
                <TabsList variant="weight">
                  <TabsTrigger value="installed" variant="weight">
                    {t("discover.tabInstalled")}
                  </TabsTrigger>
                  <TabsTrigger value="discover" variant="weight">
                    {t("discover.tabDiscover")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
          </div>
        </div>
        {discoveryEnabled && viewMode === "discover" ? (
          <SkillDiscoveryView
            searchQuery={searchQuery}
            remote={remote}
            onSelectSkill={handleSelectRemoteSkill}
            onInstallSkill={(skill) =>
              void remote.install(skill, {
                projectDir: selectedProjectScopeDir,
                destinationLabel: selectedProjectScopeDir
                  ? `${selectedScopeLabel} (${selectedProjectScopeDir})`
                  : null,
              })
            }
          />
        ) : (
          <SkillsGrid
            skills={visibleSkills}
            isLoading={loading}
            onSelectSkill={handleSelectSkill}
            onCreateSkill={handleNewSkill}
            onEditSkill={handleEdit}
            onDeleteSkill={handleDelete}
          />
        )}
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept=".skill.json,.json"
        className="hidden"
        onChange={handleFileChange}
      />

      {dialogs}
    </PageShell>
  );
}
