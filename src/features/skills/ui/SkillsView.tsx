import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPlus, IconUpload } from "@tabler/icons-react";
import { toast } from "sonner";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { Button } from "@/shared/ui/button";
import { PageHeader, PageShell } from "@/shared/ui/page-shell";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { useSkillImportExport } from "../hooks/useSkillImportExport";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsDialogs } from "./SkillsDialogs";
import { SkillsGrid } from "./SkillsGrid";
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

  const activeSkill =
    skills.find((skill) => skill.id === currentActiveSkillId) ?? null;

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

  const handleNewSkill = () => {
    setEditingSkill(undefined);
    setDialogOpen(true);
  };

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
      deletingSkill={deletingSkill}
      onDeletingSkillChange={setDeletingSkill}
      onConfirmDelete={handleConfirmDeleteSkill}
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
      <PageHeader
        title={t("view.title")}
        titleClassName="sr-only"
        actions={
          <>
            <Button
              type="button"
              variant="outline-flat"
              size="xs"
              onClick={openFilePicker}
              leftIcon={<IconUpload />}
            >
              {t("common:actions.import")}
            </Button>
            <Button
              type="button"
              variant="outline-flat"
              size="xs"
              onClick={handleNewSkill}
              leftIcon={<IconPlus />}
            >
              {t("view.newSkill")}
            </Button>
          </>
        }
      />

      <section aria-labelledby="skills-heading">
        <SkillsGrid
          skills={skills}
          isLoading={loading}
          onSelectSkill={handleSelectSkill}
          onCreateSkill={handleNewSkill}
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
