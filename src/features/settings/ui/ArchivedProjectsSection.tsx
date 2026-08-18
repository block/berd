import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, buttonVariants } from "@/shared/ui/button";
import { SettingsRow } from "@/shared/ui/settings-row";
import { SettingsSection } from "@/shared/ui/settings-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  deleteProject,
  listArchivedProjects,
  restoreProject,
  type ProjectInfo,
} from "@/features/projects/api/projects";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { trackProjectDeleteCompleted } from "@/features/projects/lib/projectTelemetry";
import { useProjectStore } from "@/features/projects/stores/projectStore";

export function ArchivedProjectsSection() {
  const { t } = useTranslation(["settings", "common"]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectInfo[]>([]);
  const [loadingArchived, setLoadingArchived] = useState(true);
  const [deletingProject, setDeletingProject] = useState<ProjectInfo | null>(
    null,
  );

  useEffect(() => {
    listArchivedProjects()
      .then(setArchivedProjects)
      .catch(() => setArchivedProjects([]))
      .finally(() => setLoadingArchived(false));
  }, []);

  async function handleRestoreProject(id: string) {
    try {
      await restoreProject(id);
      await useProjectStore.getState().fetchProjects();
      setArchivedProjects((prev) => prev.filter((p) => p.id !== id));
    } catch {
      // best-effort
    }
  }

  async function handleDelete(project: ProjectInfo) {
    try {
      await deleteProject(project.id);
      // Completed only after the delete resolves; `project` is the pre-deletion
      // snapshot for had_working_dir / had_artifact.
      trackProjectDeleteCompleted(project);
      setArchivedProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch {
      // best-effort
    }
  }

  return (
    <>
      <SettingsSection title={t("projects.sectionTitle")}>
        {!loadingArchived && archivedProjects.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("projects.empty")}</p>
        ) : null}
        {archivedProjects.map((project) => (
          <SettingsRow
            key={project.id}
            density="compact"
            leading={
              <ProjectIcon
                icon={project.icon}
                color={project.color}
                className="size-4 shrink-0 text-foreground"
                imageClassName="size-4 shrink-0 rounded-xs"
              />
            }
            label={<span className="block truncate">{project.name}</span>}
            action={
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => handleRestoreProject(project.id)}
                >
                  {t("common:actions.restore")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  destructive
                  onClick={() => setDeletingProject(project)}
                >
                  {t("common:actions.delete")}
                </Button>
              </div>
            }
          />
        ))}
      </SettingsSection>

      <AlertDialog
        open={!!deletingProject}
        onOpenChange={(open) => !open && setDeletingProject(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteProject.title", {
                name: deletingProject?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteProject.description", {
                name: deletingProject?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({
                variant: "primary",
                destructive: true,
              })}
              onClick={() => {
                if (deletingProject) {
                  void handleDelete(deletingProject);
                  setDeletingProject(null);
                }
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
