import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowDownToArc,
  IconChevronDown,
  IconRefresh,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { PageShell } from "@/shared/ui/page-shell";
import { PageToolbarButton } from "@/shared/ui/page-toolbar-button";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Spinner } from "@/shared/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { useSkillImportExport } from "../hooks/useSkillImportExport";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsDialogs } from "./SkillsDialogs";
import { SkillsGrid } from "./SkillsGrid";
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
    return skill.sourceKind === "global";
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
  const reduceMotion = useReducedMotion();
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchCloseVisible, setSearchCloseVisible] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSearchFocusRef = useRef(false);
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
  // Load the catalog while discovery is enabled so both tab counts are
  // available before the user switches views and remote detail routes can
  // resolve immediately after a remount.
  const remote = useRemoteSkills(
    discoveryEnabled,
    viewMode === "discover" || remoteSkillName !== null,
  );

  useEffect(() => {
    if (!discoveryEnabled && viewMode === "discover") {
      setViewMode("installed");
      setSelectedRemoteSkill(null);
    }
  }, [discoveryEnabled, viewMode]);

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
      setSkillScope(viewMode === "discover" ? "global" : "all");
    }
  }, [projectsWithSkillDirs, skillScope, viewMode]);

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
    return skillScope === "all"
      ? t("view.scope.all")
      : t("view.scope.personal");
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

  useEffect(() => {
    if (!searchOpen) {
      setSearchCloseVisible(false);
      if (restoreSearchFocusRef.current) {
        restoreSearchFocusRef.current = false;
        window.requestAnimationFrame(() => searchTriggerRef.current?.focus());
      }
      return;
    }
    searchInputRef.current?.focus();
    if (reduceMotion) {
      setSearchCloseVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setSearchCloseVisible(true), 180);
    return () => window.clearTimeout(timer);
  }, [reduceMotion, searchOpen]);

  const closeSearch = useCallback(() => {
    restoreSearchFocusRef.current = true;
    setSearchQuery("");
    setSearchOpen(false);
  }, []);

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
        className="mx-auto flex w-full max-w-[70rem] flex-col gap-10"
      >
        <Tabs
          value={viewMode}
          onValueChange={(value) => {
            const nextView = value as "installed" | "discover";
            setViewMode(nextView);
            if (nextView === "discover" && skillScope === "all") {
              setSkillScope("global");
            }
            setSelectedRemoteSkill(null);
            if (remoteSkillName) {
              setActiveSkill(null, { replace: true });
            }
          }}
          className="contents"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            {discoveryEnabled ? (
              <TabsList variant="segmented">
                <TabsTrigger
                  value="installed"
                  variant="segmented"
                  aria-label={t("discover.tabInstalledCount", {
                    count: skills.length,
                  })}
                >
                  {t("discover.tabInstalled")}
                  <span className="relative -top-px ml-1 inline-flex items-center justify-center text-[10px] leading-none tabular-nums text-muted-foreground">
                    {skills.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="discover"
                  variant="segmented"
                  aria-label={t("discover.tabDiscoverCount", {
                    count:
                      remote.catalogState === "ready"
                        ? remote.skills.length
                        : "–",
                  })}
                >
                  {t("discover.tabDiscover")}
                  <span className="relative -top-px ml-1 inline-flex items-center justify-center text-[10px] leading-none tabular-nums text-muted-foreground">
                    {remote.catalogState === "ready"
                      ? remote.skills.length
                      : "–"}
                  </span>
                </TabsTrigger>
              </TabsList>
            ) : null}
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <PageToolbarButton
                    type="button"
                    size="xs"
                    className="max-w-44 text-sm"
                    aria-label={t(
                      viewMode === "discover"
                        ? "view.scope.installDestinationAriaLabel"
                        : "view.scope.ariaLabel",
                    )}
                    rightIcon={<IconChevronDown />}
                  >
                    <span className="min-w-0 truncate">
                      {selectedScopeLabel}
                    </span>
                  </PageToolbarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    value={skillScope}
                    onValueChange={(value) =>
                      setSkillScope(value as SkillScope)
                    }
                  >
                    {viewMode === "installed" ? (
                      <DropdownMenuRadioItem value="all" indicatorSide="end">
                        {t("view.scope.all")}
                      </DropdownMenuRadioItem>
                    ) : null}
                    <DropdownMenuRadioItem value="global" indicatorSide="end">
                      {t("view.scope.personal")}
                    </DropdownMenuRadioItem>
                    {projectsWithSkillDirs.length > 0 ? (
                      <DropdownMenuLabel className="pt-4 text-sm text-muted-foreground/60">
                        {t("view.scope.projects")}
                      </DropdownMenuLabel>
                    ) : null}
                    {projectsWithSkillDirs.map((project) => (
                      <DropdownMenuRadioItem
                        key={project.id}
                        value={`project:${project.id}`}
                        indicatorSide="end"
                      >
                        {project.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <AnimatePresence initial={false} mode="popLayout">
                {searchOpen || searchQuery ? (
                  <motion.div
                    key="search-field"
                    initial={{ width: 32, opacity: 0 }}
                    animate={{
                      width: "min(256px, calc(100vw - 96px))",
                      opacity: 1,
                    }}
                    exit={{ width: 32, opacity: 0 }}
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 420, damping: 38 }
                    }
                    data-search-field-container
                    data-search-motion={reduceMotion ? "reduced" : "full"}
                    className="relative overflow-hidden rounded-full"
                  >
                    <SearchBar
                      size="pill-card"
                      value={searchQuery}
                      onChange={setSearchQuery}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          closeSearch();
                        }
                      }}
                      placeholder={t("view.searchPlaceholder")}
                      aria-label={t("view.searchAriaLabel")}
                      inputRef={searchInputRef}
                      className="w-64 pr-9"
                    />
                    {searchCloseVisible ? (
                      <div className="absolute right-1 top-1/2 -translate-y-1/2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("common:actions.close")}
                          title={t("common:actions.close")}
                          onClick={closeSearch}
                        >
                          <svg
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                            className="!size-4"
                          >
                            <path
                              d="M3.5 3.5l9 9m0-9l-9 9"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                          </svg>
                        </Button>
                      </div>
                    ) : null}
                  </motion.div>
                ) : (
                  <motion.div
                    key="search-action"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={reduceMotion ? { duration: 0 } : undefined}
                  >
                    <PageToolbarButton
                      ref={searchTriggerRef}
                      type="button"
                      size="icon-xs"
                      aria-label={t("view.searchAriaLabel")}
                      title={t("view.searchAriaLabel")}
                      onClick={() => setSearchOpen(true)}
                    >
                      <IconSearch className="!size-4" />
                    </PageToolbarButton>
                  </motion.div>
                )}
              </AnimatePresence>
              <PageToolbarButton
                type="button"
                size="icon-xs"
                aria-label={t("common:actions.import")}
                tooltip={t("common:actions.import")}
                onClick={openFilePicker}
              >
                <IconArrowDownToArc className="!size-4" />
              </PageToolbarButton>
              <PageToolbarButton
                type="button"
                size="icon-xs"
                aria-label={t("view.newSkill")}
                tooltip={t("view.newSkill")}
                onClick={handleNewSkill}
              >
                <IconPlus className="!size-4" />
              </PageToolbarButton>
            </div>
          </div>
          {discoveryEnabled ? (
            <>
              <TabsContent value="installed">
                <SkillsGrid
                  skills={visibleSkills}
                  isLoading={loading}
                  onSelectSkill={handleSelectSkill}
                  onCreateSkill={handleNewSkill}
                  onEditSkill={handleEdit}
                  onDeleteSkill={handleDelete}
                />
              </TabsContent>
              <TabsContent value="discover">
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
              </TabsContent>
            </>
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
        </Tabs>
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept=".skill.json,.json,application/json"
        className="hidden"
        onChange={handleFileChange}
      />

      {dialogs}
    </PageShell>
  );
}
