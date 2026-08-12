import { useEffect, useState } from "react";
import {
  ArrowRight,
  Folder,
  FolderGit,
  GitBranch,
  GitFork,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { getWorkspaceTitle } from "@/features/chat/lib/workspaceAttachments";
import type { ProjectWorkspace } from "@/features/projects/api/projects";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";

interface ProjectWorkspaceStartupNameDialogProps {
  open: boolean;
  creating?: boolean;
  requiresWorktreeSafeName?: boolean;
  workspaces?: ProjectWorkspace[];
  /** Changes when an already-open dialog advances to a different naming request. */
  requestIdentity?: object;
  onCancel: () => void;
  onSkip: () => void;
  onSubmit: (name: string) => void;
}

function isInvalidWorktreeName(name: string): boolean {
  return name === "." || name === ".." || /[/\\]/.test(name);
}

function WorkspacePreviewIcon({
  workspace,
  className,
}: {
  workspace: ProjectWorkspace;
  className?: string;
}) {
  if (workspace.kind === "git-linked-worktree") {
    return <GitFork className={className} />;
  }

  if (
    workspace.kind === "repository" ||
    workspace.kind === "git-main-worktree" ||
    workspace.kind === "git-detached-checkout" ||
    Boolean(workspace.repositoryPath)
  ) {
    return <FolderGit className={className} />;
  }

  return <Folder className={className} />;
}

export function ProjectWorkspaceStartupNameDialog({
  open,
  creating = false,
  requiresWorktreeSafeName = false,
  workspaces = [],
  requestIdentity,
  onCancel,
  onSkip,
  onSubmit,
}: ProjectWorkspaceStartupNameDialogProps) {
  const { t } = useTranslation("projects");
  const [name, setName] = useState("");
  const [showSkipPreview, setShowSkipPreview] = useState(false);
  const trimmedName = name.trim();
  const nameError =
    requiresWorktreeSafeName && isInvalidWorktreeName(trimmedName)
      ? t("dialog.startupName.worktreeNameError")
      : null;

  useEffect(() => {
    void requestIdentity;
    if (open) {
      setName("");
      setShowSkipPreview(false);
    }
  }, [open, requestIdentity]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent className="max-w-[600px] gap-0 rounded-[22px] bg-background p-0">
        <DialogHeader className="px-6 pb-5 pt-6">
          <DialogTitle className="text-xl font-semibold leading-7 tracking-normal">
            {t("dialog.startupName.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialog.startupName.description")}
          </DialogDescription>
        </DialogHeader>

        <form
          id="project-workspace-startup-name-form"
          className="space-y-6 px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedName && !nameError && !creating) {
              onSubmit(trimmedName);
            }
          }}
        >
          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">
              {t("dialog.startupName.effect")}
            </div>
            <div className="space-y-1 rounded-[10px] border border-border bg-background px-3 py-2">
              {workspaces.map((workspace) => {
                const workspaceTitle = getWorkspaceTitle(workspace);
                const createsWorktree = workspace.startupMode === "worktree";
                const usesExistingWorkspace = workspace.startupMode === "none";
                const generatedPreviewName =
                  trimmedName ||
                  (createsWorktree
                    ? t("dialog.startupName.worktreePlaceholder")
                    : t("dialog.startupName.branchPlaceholder"));
                const TargetIcon = createsWorktree ? GitFork : GitBranch;
                const previewName = usesExistingWorkspace
                  ? t("dialog.workspacePolicy.neither")
                  : generatedPreviewName;
                return (
                  <div
                    key={workspace.path}
                    className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-sm"
                  >
                    <span className="inline-flex min-w-0 items-center gap-2 text-foreground">
                      <WorkspacePreviewIcon
                        workspace={workspace}
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 truncate">{workspaceTitle}</span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    <span
                      className={cn(
                        "inline-flex min-w-0 items-center gap-2 text-muted-foreground",
                        (usesExistingWorkspace || trimmedName) &&
                          "text-foreground",
                        !usesExistingWorkspace &&
                          showSkipPreview &&
                          "line-through opacity-60",
                      )}
                    >
                      {usesExistingWorkspace ? (
                        <WorkspacePreviewIcon
                          workspace={workspace}
                          className="size-4 shrink-0"
                        />
                      ) : (
                        <TargetIcon className="size-4 shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{previewName}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <Label
                htmlFor="project-workspace-startup-name"
                className="text-sm font-medium text-foreground"
              >
                {t("dialog.startupName.label")}
              </Label>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("dialog.startupName.helper")}
              </p>
            </div>
            <Input
              id="project-workspace-startup-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("dialog.startupName.placeholder")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={creating}
              aria-invalid={Boolean(nameError)}
              aria-describedby={
                nameError ? "project-workspace-startup-name-error" : undefined
              }
              className="h-12 rounded-[10px]"
              required
              autoFocus
            />
            {nameError ? (
              <p
                id="project-workspace-startup-name-error"
                className="text-xs text-destructive"
              >
                {nameError}
              </p>
            ) : null}
          </div>
        </form>

        <DialogFooter className="items-center border-t px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={onSkip}
            onFocus={() => setShowSkipPreview(true)}
            onBlur={() => setShowSkipPreview(false)}
            onMouseEnter={() => setShowSkipPreview(true)}
            onMouseLeave={() => setShowSkipPreview(false)}
            disabled={creating}
            flush
            className="h-10 px-4 font-semibold"
          >
            {t("dialog.startupName.skip")}
          </Button>
          <Button
            type="submit"
            form="project-workspace-startup-name-form"
            className="h-10 min-w-24 px-6 font-semibold"
            disabled={!trimmedName || Boolean(nameError) || creating}
          >
            {creating
              ? t("dialog.startupName.creating")
              : t("dialog.startupName.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
