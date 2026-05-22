import { useState, useEffect, useRef, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { IconFolderPlus } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { getHomeDir } from "@/shared/api/system";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import {
  createProject,
  updateProject,
  type ProjectInfo,
} from "../api/projects";
import { discoverAcpProviders, type AcpProvider } from "@/shared/api/acp";
import {
  buildEditorText,
  hasEquivalentWorkingDir,
  parseEditorText,
} from "../lib/projectPromptText";
import { DEFAULT_PROJECT_ICON } from "../lib/projectIcons";
import { DEFAULT_PROJECT_COLOR } from "../lib/projectDefaults";
import { pillCssColor, type PillTone } from "../lib/pillTones";
import { ProjectColorPicker } from "./ProjectColorPicker";
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
  const [preferredProvider, setPreferredProvider] = useState<string | null>(
    null,
  );
  const preferredModel: string | null = null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acpProviders, setAcpProviders] = useState<AcpProvider[]>([]);
  // Icon picker UI is removed from the redesigned form, but ProjectInfo.icon
  // is still consumed elsewhere. We carry the icon value through the form
  // (defaulting to DEFAULT_PROJECT_ICON for new projects, preserving the
  // existing value when editing) so we don't accidentally clobber it.
  const [icon, setIcon] = useState<string>(DEFAULT_PROJECT_ICON);
  // First working directory selected via the folder picker. Edits write
  // through to the prompt text (via insertWorkingDir) so the underlying
  // include-directives storage stays the source of truth.
  const [workingDir, setWorkingDir] = useState<string>("");

  const isEditing = !!editingProject;

  useEffect(() => {
    discoverAcpProviders()
      .then(setAcpProviders)
      .catch(() => setAcpProviders([]));
  }, []);

  const handleAddDirectory = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("dialog.addDirectoryDialogTitle"),
      });
      if (selected && typeof selected === "string") {
        const homeDir = await getHomeDir().catch(() => null);

        setWorkingDir(selected);
        setWorkingDirs((prev) => {
          if (
            hasEquivalentWorkingDir(
              buildEditorText(prev, prompt),
              selected,
              homeDir,
            )
          ) {
            return prev;
          }
          return [...prev, selected];
        });
      }
    } catch {
      // Dialog plugin not available
    }
  };

  // Pre-fill fields when the dialog opens or when the project identity changes,
  // but NOT on every parent re-render (which would reset user edits mid-typing).
  const prevOpenRef = useRef(false);
  const prevEditingIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const justOpened = isOpen && !prevOpenRef.current;
    prevOpenRef.current = isOpen;

    const projectIdChanged =
      isOpen && !justOpened && editingProject?.id !== prevEditingIdRef.current;
    prevEditingIdRef.current = editingProject?.id;

    if (!justOpened && !projectIdChanged) return;

    if (editingProject) {
      setName(editingProject.name);
      setPrompt(editingProject.prompt);
      setWorkingDirs(editingProject.workingDirs);
      setIcon(editingProject.icon || DEFAULT_PROJECT_ICON);
      setColor(editingProject.color || DEFAULT_PROJECT_COLOR);
      setPreferredProvider(editingProject.preferredProvider ?? null);
      setWorkingDir(editingProject.workingDirs[0] ?? "");
      setError(null);
    } else {
      const seedDir = initialWorkingDir?.trim() ?? "";
      setName(getDefaultProjectName(initialWorkingDir));
      setPrompt("");
      setWorkingDirs(seedDir ? [seedDir] : []);
      setIcon(DEFAULT_PROJECT_ICON);
      setColor(DEFAULT_PROJECT_COLOR);
      setPreferredProvider(null);
      setWorkingDir(seedDir);
      setError(null);
    }
  }, [isOpen, editingProject, initialWorkingDir]);

  const canSave = name.trim().length > 0 && !saving;

  const handleClose = () => {
    setName("");
    setPrompt("");
    setWorkingDirs([]);
    setIcon(DEFAULT_PROJECT_ICON);
    setColor(DEFAULT_PROJECT_COLOR);
    setPreferredProvider(null);
    setWorkingDir("");
    setError(null);
    onClose();
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    // Prompt buffer is the source of truth for workingDirs (encoded as
    // `include:` directives). If the folder picker captured a dir but the
    // prompt buffer hasn't been seeded yet (e.g. user picked then edited
    // the prompt), the prompt buffer wins.
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
          preferredProvider: preferredProvider || null,
          preferredModel,
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
          preferredProvider || null,
          preferredModel,
          savedWorkingDirs,
          false,
        );
      }
      onCreated(savedProject);
      onClose();
    } catch (err) {
      setError(String(err));
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
  const selectedPanelColor =
    pillCssColor(color) ??
    (/^#[0-9a-f]{3,8}$/i.test(color) ? color : null) ??
    pillCssColor(DEFAULT_PROJECT_COLOR) ??
    "#c4e2f6";

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        className="top-3 right-3 bottom-3 h-auto w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-[24px] bg-[rgba(196,226,246,0.26)] p-0 shadow-[0_22px_72px_rgba(15,23,42,0.18)] backdrop-blur-2xl transition-colors duration-500 ease-out sm:top-5 sm:right-5 sm:bottom-5 sm:w-[560px] sm:max-w-none"
        closeButtonClassName="top-5 right-5 rounded-full bg-transparent opacity-80 hover:bg-white/50"
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

          {/* Hero stays transparent so the glass panel reveals whatever sits
              underneath instead of painting a fake backdrop. */}
          <div className="relative h-[400px] shrink-0 overflow-hidden px-8 pb-4">
            <ProjectArtifactPreview
              input={{
                projectId: editingProject?.id ?? null,
                name,
                prompt,
                color,
                workingDirs,
              }}
              className="h-full w-full"
            />
            <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">
              <ProjectColorPicker
                value={color}
                onChange={(tone: PillTone) => setColor(tone)}
                variant="swatches"
              />
            </div>
          </div>

          {/* Scrollable form body. */}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-transparent px-6 py-5 sm:px-8">
            <div className="group/field space-y-2">
              <Label className="text-[10px] leading-3 font-normal text-[#242424] opacity-40 group-hover/field:opacity-100 group-focus-within/field:opacity-100">
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
                className="h-[42px] !rounded-[10px] border-0 bg-white px-3.5 py-0 text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[border-radius,box-shadow,background-color] duration-200 placeholder:text-[#242424]/30 hover:!rounded-[20px] hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:!rounded-[20px] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:!rounded-[20px] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)]"
              />
            </div>

            <div className="group/field space-y-2">
              <Label className="text-[10px] leading-3 font-normal text-[#242424] opacity-40 group-hover/field:opacity-100 group-focus-within/field:opacity-100">
                {t("dialog.describeLabel")}
              </Label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("dialog.describePlaceholder")}
                rows={4}
                className="h-[215px] min-h-[215px] w-full resize-none rounded-[10px] border-0 bg-white px-3.5 py-[13px] text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[border-radius,box-shadow,background-color] duration-200 placeholder:text-[#242424]/30 hover:rounded-[28px] hover:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus:rounded-[28px] focus:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="group/field space-y-2">
                <Label className="text-[10px] leading-3 font-normal text-[#242424] opacity-40 group-hover/field:opacity-100 group-focus-within/field:opacity-100">
                  {t("dialog.folderLabel")}
                </Label>
                <button
                  type="button"
                  onClick={handleAddDirectory}
                  className={cn(
                    "h-[42px] !rounded-[10px] border-0 bg-white pr-3.5 pl-[17px] text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[border-radius,box-shadow,background-color] duration-200 hover:!rounded-[20px] hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:!rounded-[20px] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:!rounded-[20px] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)]",
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
                <Label className="text-[10px] leading-3 font-normal text-[#242424] opacity-40 group-hover/field:opacity-100 group-focus-within/field:opacity-100">
                  {t("dialog.modelLabel")}
                </Label>
                <Select
                  value={preferredProvider ?? "__none__"}
                  onValueChange={(v) =>
                    setPreferredProvider(v === "__none__" ? null : v)
                  }
                >
                  <SelectTrigger
                    className={cn(
                      "!h-[42px] min-h-[42px] !rounded-[10px] border-0 bg-white px-3.5 py-0 text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[border-radius,box-shadow,background-color] duration-200 data-[placeholder]:text-[#242424]/30 data-[size=default]:!h-[42px] hover:!rounded-[20px] hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:!rounded-[20px] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:!rounded-[20px] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)] data-[state=open]:!rounded-[20px] data-[state=open]:shadow-[0_1px_1px_rgba(0,0,0,0.24)]",
                      "w-full",
                    )}
                  >
                    <SelectValue placeholder={t("dialog.modelPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      {t("dialog.noneUseDefault")}
                    </SelectItem>
                    {acpProviders.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          {/* Footer: Cancel (left) + Save/Create (right). */}
          <div className="flex shrink-0 items-center justify-end gap-3 bg-transparent px-6 pt-2 pb-7 sm:px-8">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClose}
              disabled={saving}
              className="h-10 rounded-full px-4 text-sm hover:bg-white/50"
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              form="project-form"
              variant="default"
              size="sm"
              disabled={!canSave}
              className="h-10 rounded-full !bg-[#242424] px-5 text-sm !text-white hover:!bg-[#242424]/90 disabled:!bg-[#242424] disabled:!text-white"
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
