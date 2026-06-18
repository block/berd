import { useState, useEffect, useMemo, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconFolderPlus } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { checkDirectoriesExist, resolvePath } from "@/shared/api/pathResolver";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  createProject,
  updateProject,
  type ProjectInfo,
} from "../api/projects";
import { buildEditorText, parseEditorText } from "../lib/projectPromptText";
import { useProjectIconSelection } from "../hooks/useProjectIconSelection";
import { DEFAULT_PROJECT_ICON } from "../lib/projectIcons";
import { DEFAULT_PROJECT_COLOR } from "../lib/projectDefaults";
import { pillCssColor } from "../lib/pillTones";
import { ProjectColorPicker } from "./ProjectColorPicker";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { ProjectArtifactPreview } from "../artifact/ProjectArtifactPreview";

function getDefaultProjectName(path: string | null | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

interface CreateProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
  initialWorkingDir?: string | null;
  editingProject?: ProjectInfo;
}

export function CreateProjectDialog({
  isOpen,
  onClose,
  onCreated,
  initialWorkingDir,
  editingProject,
}: CreateProjectDialogProps) {
  const { t } = useTranslation(["projects", "common"]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workingDirs, setWorkingDirs] = useState<string[]>([]);
  const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLOR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    icon,
    iconCandidates,
    iconError,
    chooseIcon,
    chooseCustomIcon,
    resetIcon,
  } = useProjectIconSelection({
    isOpen,
    prompt: buildEditorText(workingDirs, prompt),
  });
  // First working directory selected via the folder picker. The persisted
  // workingDirs list stays the source of truth, while prompt text remains
  // the user's project description.
  const [workingDir, setWorkingDir] = useState<string>("");
  // Working directories that don't currently exist on disk, surfaced as a
  // warning on the folder field so users can fix the paths before saving.
  const [missingDirs, setMissingDirs] = useState<string[]>([]);

  const isEditing = !!editingProject;

  // Re-check the configured folders against the filesystem whenever they
  // change while the dialog is open. All workingDirs are validated, not just
  // the first, so a missing secondary folder is still surfaced.
  useEffect(() => {
    if (!isOpen) {
      setMissingDirs([]);
      return;
    }
    const dirs = workingDirs
      .map((directory) => directory?.trim())
      .filter((directory): directory is string => Boolean(directory));
    if (dirs.length === 0) {
      setMissingDirs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resolved = await Promise.all(
          dirs.map((directory) =>
            resolvePath({ parts: [directory] }).then((result) => result.path),
          ),
        );
        const missing = await checkDirectoriesExist(resolved);
        if (cancelled) return;
        // Report the user's original folder strings rather than the resolved
        // absolute paths, since those are what they recognize.
        setMissingDirs(
          dirs.filter((_, index) => missing.includes(resolved[index])),
        );
      } catch {
        if (!cancelled) setMissingDirs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, workingDirs]);

  const handleAddDirectory = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("dialog.addDirectoryDialogTitle"),
      });
      if (selected && typeof selected === "string") {
        // The picker is a single "change the folder" control, so replace the
        // working-dir list rather than appending. This swaps workingDirs[0],
        // which drives both the form display and new conversations.
        setWorkingDir(selected);
        setWorkingDirs([selected]);
      }
    } catch {
      // Dialog plugin not available
    }
  };

  const handleChooseCustomIcon = async () => {
    await chooseCustomIcon({
      title: t("dialog.customIconDialogTitle"),
      filterName: t("dialog.iconFileFilter"),
    });
  };

  // Pre-fill fields when the dialog opens or when the project identity changes,
  // but NOT on every parent re-render (which would reset user edits mid-typing).
  const [previousOpen, setPreviousOpen] = useState(false);
  const [previousEditingId, setPreviousEditingId] = useState<
    string | undefined
  >(undefined);
  const justOpened = isOpen && !previousOpen;
  const projectIdChanged =
    isOpen && !justOpened && editingProject?.id !== previousEditingId;
  if (previousOpen !== isOpen || previousEditingId !== editingProject?.id) {
    setPreviousOpen(isOpen);
    setPreviousEditingId(editingProject?.id);
  }

  if (justOpened || projectIdChanged) {
    if (editingProject) {
      setName(editingProject.name);
      setPrompt(editingProject.prompt);
      setWorkingDirs(editingProject.workingDirs);
      resetIcon(editingProject.icon || DEFAULT_PROJECT_ICON);
      setColor(editingProject.color || DEFAULT_PROJECT_COLOR);
      setWorkingDir(editingProject.workingDirs[0] ?? "");
      setError(null);
    } else {
      const seedDir = initialWorkingDir?.trim() ?? "";
      setName(getDefaultProjectName(initialWorkingDir));
      setPrompt("");
      setWorkingDirs(seedDir ? [seedDir] : []);
      resetIcon(DEFAULT_PROJECT_ICON);
      setColor(DEFAULT_PROJECT_COLOR);
      setWorkingDir(seedDir);
      setError(null);
    }
  }

  const canSave = name.trim().length > 0 && !saving;

  const handleClose = () => {
    setName("");
    setPrompt("");
    setWorkingDirs([]);
    resetIcon(DEFAULT_PROJECT_ICON);
    setColor(DEFAULT_PROJECT_COLOR);
    setWorkingDir("");
    setError(null);
    onClose();
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    // Preserve typed include-directives for older project prompts, while the
    // folder picker keeps its own workingDirs state in the redesigned form.
    const { prompt: parsedPrompt, workingDirs: parsedWorkingDirs } =
      parseEditorText(prompt);
    const savedWorkingDirs = [...workingDirs];
    for (const directory of parsedWorkingDirs) {
      if (!savedWorkingDirs.includes(directory)) {
        savedWorkingDirs.push(directory);
      }
    }
    try {
      let savedProject: ProjectInfo;
      if (isEditing) {
        savedProject = await updateProject(editingProject, {
          name: name.trim(),
          description: editingProject.description ?? "",
          prompt: parsedPrompt,
          icon,
          color,
          workingDirs: savedWorkingDirs,
          useWorktrees: editingProject.useWorktrees,
        });
      } else {
        savedProject = await createProject(
          name.trim(),
          "",
          parsedPrompt,
          icon,
          color,
          savedWorkingDirs,
          false,
        );
      }
      onCreated(savedProject);
      onClose();
    } catch (err) {
      setError(formatAcpErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const folderDisplay = workingDir
    ? workingDir.split(/[\\/]/).filter(Boolean).pop()
    : null;

  const titleText = isEditing
    ? t("dialog.editTitle")
    : t("dialog.newTitleShort");
  const shouldUseSavedPreviewArtifact =
    editingProject !== undefined && name.trim() === editingProject.name;
  const previewArtifact = shouldUseSavedPreviewArtifact
    ? (editingProject?.artifact ?? null)
    : null;
  const selectedPanelColor =
    pillCssColor(color) ??
    (/^#[0-9a-f]{3,8}$/i.test(color) ? color : null) ??
    pillCssColor(DEFAULT_PROJECT_COLOR) ??
    "#c4e2f6";

  // Keep a stable `input` reference so the hero renderer only reconciles when a
  // field it actually derives from changes. A fresh object literal here would
  // bust the renderer's input-keyed memo on every keystroke and icon change,
  // re-rendering the heavy three.js scene and freezing the dialog.
  const previewInput = useMemo(
    () => ({
      projectId: editingProject?.id ?? null,
      name,
      prompt,
      color,
      workingDirs,
      artifact: previewArtifact,
    }),
    [editingProject?.id, name, prompt, color, workingDirs, previewArtifact],
  );

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        className="top-3 right-3 bottom-3 h-auto w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-[24px] bg-[rgba(196,226,246,0.26)] p-0 shadow-[0_22px_72px_rgba(15,23,42,0.18)] backdrop-blur-2xl transition-colors duration-500 ease-out sm:top-5 sm:right-5 sm:bottom-5 sm:w-[560px] sm:max-w-none"
        closeButtonClassName="top-5 right-5 rounded-sm bg-transparent opacity-80 hover:bg-white/50"
        overlayClassName="bg-transparent"
        style={{
          backgroundColor: `color-mix(in oklab, ${selectedPanelColor} 26%, transparent)`,
        }}
        aria-describedby={undefined}
      >
        <form
          id="project-form"
          onSubmit={handleSave}
          className="flex h-full min-h-0 flex-col"
        >
          {/* Header: title at top-left. Sheet renders its own close X. */}
          <div className="flex items-center gap-2 px-8 pt-5 pb-2">
            <SheetTitle className="truncate text-sm font-normal text-foreground">
              {titleText}
            </SheetTitle>
          </div>

          {/* Scrollable content body. The project preview scrolls with the form;
              only the sheet header/close button and footer remain fixed. */}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-transparent px-6 py-5 sm:px-8">
            {/* Hero stays transparent so the glass panel reveals whatever sits
                underneath instead of painting a fake backdrop. */}
            <div className="relative h-[300px] shrink-0 overflow-hidden pb-4">
              <ProjectArtifactPreview
                input={previewInput}
                className="h-full w-full"
              />
              <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">
                <ProjectColorPicker
                  value={color}
                  onChange={setColor}
                  variant="swatches"
                />
              </div>
            </div>

            <ProjectIconPicker
              icon={icon}
              color={color}
              iconCandidates={iconCandidates}
              error={iconError}
              onChooseIcon={chooseIcon}
              onChooseCustomIcon={handleChooseCustomIcon}
            />

            <div className="group/field space-y-2">
              <Label className="text-xs font-normal text-muted-foreground transition-colors group-hover/field:text-foreground group-focus-within/field:text-foreground">
                {t("dialog.nameLabel")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder={t("dialog.nameInlinePlaceholder")}
                className="h-[42px] rounded-sm border-0 bg-white px-3.5 py-0 text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[box-shadow,background-color] duration-200 placeholder:text-[#242424]/30 hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)]"
              />
            </div>

            <div className="group/field space-y-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs font-normal text-muted-foreground transition-colors group-hover/field:text-foreground group-focus-within/field:text-foreground">
                  {t("dialog.folderLabel")}
                </Label>
                {missingDirs.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-destructive"
                        aria-label={t("dialog.invalidFolderTooltip", {
                          count: missingDirs.length,
                        })}
                      >
                        <IconAlertTriangle
                          className="size-3.5 text-destructive"
                          aria-hidden="true"
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px]">
                      <p>
                        {t("dialog.invalidFolderTooltip", {
                          count: missingDirs.length,
                        })}
                      </p>
                      <ul className="mt-1 list-disc pl-4">
                        {missingDirs.map((directory) => (
                          <li key={directory} className="break-all">
                            {directory}
                          </li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              <button
                type="button"
                onClick={handleAddDirectory}
                className={cn(
                  "h-[42px] rounded-sm border-0 bg-white pr-3.5 pl-[17px] text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[box-shadow,background-color] duration-200 hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)]",
                  "flex w-full items-center gap-2.5 text-left",
                )}
              >
                <IconFolderPlus
                  className="size-3 text-[#242424]"
                  aria-hidden="true"
                />
                <span
                  className={
                    folderDisplay
                      ? "truncate text-[#242424]"
                      : "truncate text-[#242424]/30"
                  }
                >
                  {folderDisplay ?? t("dialog.folderPlaceholder")}
                </span>
              </button>
            </div>

            <div className="group/field space-y-2">
              <Label className="text-xs font-normal text-muted-foreground transition-colors group-hover/field:text-foreground group-focus-within/field:text-foreground">
                {t("dialog.describeLabel")}
              </Label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("dialog.describePlaceholder")}
                rows={4}
                className="h-[215px] min-h-[215px] w-full resize-none rounded-sm border-0 bg-white px-3.5 py-[13px] text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[box-shadow,background-color] duration-200 placeholder:text-[#242424]/30 hover:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus:outline-none"
              />
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          {/* Footer: Cancel (left) + Save/Create (right). */}
          <div className="flex shrink-0 items-center justify-end gap-3 bg-transparent px-6 py-3 sm:px-8">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClose}
              disabled={saving}
              className="h-10 rounded-sm px-4 text-sm hover:bg-white/50"
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              form="project-form"
              variant="default"
              size="sm"
              disabled={!canSave}
              className="h-10 rounded-sm !bg-[#242424] px-5 text-sm !text-white hover:!bg-[#242424]/90 disabled:!bg-[#242424] disabled:!text-white"
            >
              {saving
                ? isEditing
                  ? t("dialog.saving")
                  : t("dialog.creating")
                : isEditing
                  ? t("common:actions.saveChanges")
                  : t("dialog.createProject")}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
