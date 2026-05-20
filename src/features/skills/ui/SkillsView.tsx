import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconPlus, IconUpload } from "@tabler/icons-react";
import { toast } from "sonner";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
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
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { useSkillImportExport } from "../hooks/useSkillImportExport";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsDialogs } from "./SkillsDialogs";
import { skillsGridClass, SkillsGrid } from "./SkillsGrid";
import { hydrateProjectNames } from "../lib/projectHydration";
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
  onStartChatWithSkill?: (skill: SkillInfo, projectId?: string | null) => void;
}

type SkillScope = "all" | "global" | `project:${string}`;

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

export function SkillsView({
  activeSkillId,
  onActiveSkillIdChange,
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
  const [internalActiveSkillId, setInternalActiveSkillId] = useState<
    string | null
  >(null);
  const loadRequestIdRef = useRef(0);
  const currentActiveSkillId = isActiveSkillControlled
    ? activeSkillId
    : internalActiveSkillId;

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
    } catch {
      if (loadRequestIdRef.current === requestId) {
        setSkills([]);
        toast.error(t("view.loadError"));
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

  const activeSkill =
    skills.find((skill) => skill.id === currentActiveSkillId) ?? null;

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
    if (currentActiveSkillId && !loading && !activeSkill) {
      setActiveSkill(null, { replace: true });
    }
  }, [activeSkill, currentActiveSkillId, loading, setActiveSkill]);

  const handleDelete = (skill: SkillInfo) => {
    if (skill.readonly) {
      return;
    }
    setDeletingSkill(skill);
  };

  const handleConfirmDeleteSkill = async () => {
    if (!deletingSkill) return;
    if (deletingSkill.readonly) {
      setDeletingSkill(null);
      return;
    }
    try {
      await deleteSkill(deletingSkill.path);
      await loadSkills();
      if (currentActiveSkillId === deletingSkill.id) {
        setActiveSkill(null, { replace: true });
      }
      toast.success(t("view.deleteSuccess", { name: deletingSkill.name }));
    } catch {
      toast.error(t("view.deleteError"));
    }
    setDeletingSkill(null);
  };

  const handleEdit = (skill: SkillInfo) => {
    if (skill.readonly) {
      return;
    }
    setEditingSkill({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      path: skill.path,
      fileLocation: skill.fileLocation,
    });
    setDialogOpen(true);
  };

  const handleReveal = useCallback((skill: SkillInfo) => {
    if (skill.readonly) {
      return;
    }
    void revealInFileManager(skill.path);
  }, []);

  const handleStartChat = useCallback(
    (skill: SkillInfo) => {
      onStartChatWithSkill?.(skill, skill.projectLinks[0]?.id ?? null);
    },
    [onStartChatWithSkill],
  );

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingSkill(undefined);
  };

  // Wire Delete from inside the SkillEditor footer: close the editor sheet,
  // then surface the existing AlertDialog delete confirmation.
  const handleDeleteFromEditor = useCallback(
    (editing: EditingSkill) => {
      const match = skills.find((skill) => skill.path === editing.path);
      setDialogOpen(false);
      setEditingSkill(undefined);
      if (match) {
        setDeletingSkill(match);
      }
    },
    [skills],
  );

  const handleNewSkill = useCallback(() => {
    setEditingSkill(undefined);
    setDialogOpen(true);
  }, []);

  const handleSkillSaved = useCallback(
    async (savedSkill?: SkillInfo) => {
      const refreshedSkills = await loadSkills();
      if (
        savedSkill &&
        refreshedSkills.some((skill) => skill.id === savedSkill.id)
      ) {
        setActiveSkill(savedSkill.id);
      }
    },
    [loadSkills, setActiveSkill],
  );

  const refreshSkills = useCallback(async () => {
    await loadSkills();
  }, [loadSkills]);

  const { fileInputRef, handleFileChange, openFilePicker, handleExport } =
    useSkillImportExport(refreshSkills);

  const setTopBarActions = useSetTopBarActions();

  useEffect(() => {
    if (activeSkill) {
      setTopBarActions(null);
      return;
    }
    setTopBarActions(
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="page-header"
              size="xs"
              aria-label={t("view.scope.ariaLabel")}
              rightIcon={<IconChevronDown />}
            >
              {selectedScopeLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className={
                skillScope === "all" ? "bg-background-muted" : undefined
              }
              onSelect={() => setSkillScope("all")}
            >
              {t("view.scope.all")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                skillScope === "global" ? "bg-background-muted" : undefined
              }
              onSelect={() => setSkillScope("global")}
            >
              {t("view.scope.global")}
            </DropdownMenuItem>
            {projectsWithSkillDirs.length > 0 ? (
              <DropdownMenuLabel className="pt-2 text-xs text-text-placeholder">
                {t("view.scope.projects")}
              </DropdownMenuLabel>
            ) : null}
            {projectsWithSkillDirs.map((project) => (
              <DropdownMenuItem
                key={project.id}
                className={
                  skillScope === `project:${project.id}`
                    ? "bg-background-muted"
                    : undefined
                }
                onSelect={() => setSkillScope(`project:${project.id}`)}
              >
                {project.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="page-header"
          size="xs"
          onClick={openFilePicker}
          leftIcon={<IconUpload />}
        >
          {t("common:actions.import")}
        </Button>
        <Button
          type="button"
          variant="page-header"
          size="xs"
          onClick={handleNewSkill}
          leftIcon={<IconPlus />}
        >
          {t("view.newSkill")}
        </Button>
      </>,
    );
    return () => setTopBarActions(null);
  }, [
    activeSkill,
    handleNewSkill,
    openFilePicker,
    projectsWithSkillDirs,
    selectedScopeLabel,
    setTopBarActions,
    skillScope,
    t,
  ]);

  const handleShare = useCallback(
    (skill: SkillInfo) => {
      if (skill.readonly) {
        return;
      }
      void handleExport(skill);
    },
    [handleExport],
  );

  const handleSelectSkill = (skill: SkillInfo) => {
    setActiveSkill(skill.id);
  };

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

  if (activeSkill) {
    return (
      <>
        <SkillDetailPage
          skill={activeSkill}
          onBack={() => setActiveSkill(null)}
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
          <div className="col-span-full sm:col-span-2">
            <SearchBar
              size="pill"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t("view.searchPlaceholder")}
              aria-label={t("view.searchAriaLabel")}
            />
          </div>
        </div>
        <SkillsGrid
          skills={visibleSkills}
          isLoading={loading}
          onSelectSkill={handleSelectSkill}
          onCreateSkill={handleNewSkill}
          onEditSkill={handleEdit}
          onDeleteSkill={handleDelete}
        />
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
