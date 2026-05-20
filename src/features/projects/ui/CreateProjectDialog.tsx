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
import { pillBgClass, type PillTone } from "../lib/pillTones";
import { ProjectColorPicker } from "./ProjectColorPicker";

// Shared visual constants — mirrored from PersonaEditor / SkillEditor.
// Extract to a shared primitive once a fourth surface adopts this IA.
const SHEET_CONTENT_CLASS = "flex h-full flex-col gap-0 p-0 sm:max-w-[440px]";
const HERO_HEIGHT_CLASS = "h-[280px]";
const PILL_INPUT_CLASS =
  "h-10 rounded-full border-none bg-surface-overlay px-4 text-sm";
const FIELD_INPUT_CLASS =
  "h-10 rounded-[10px] border-none bg-surface-overlay px-4 text-sm";
const DESCRIPTION_TEXTAREA_CLASS =
  "w-full resize-none rounded-[10px] border-none bg-surface-overlay px-4 py-3 text-sm outline-none placeholder:text-placeholder focus:outline-none";
const FIELD_LABEL_CLASS = "text-[10px] font-normal text-muted-foreground";
const SECTION_GAP_CLASS = "space-y-1.5";

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

  // Hero tone block — previews the selected pill tone as a large solid color.
  // Falls back to DEFAULT_PROJECT_COLOR if `color` is a legacy hex.
  const heroToneClass =
    pillBgClass(color) ?? pillBgClass(DEFAULT_PROJECT_COLOR) ?? "";

  const titleText = isEditing
    ? t("dialog.editTitle")
    : t("dialog.newTitleShort");

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        className={SHEET_CONTENT_CLASS}
        aria-describedby={undefined}
      >
        <form
          id="project-form"
          onSubmit={handleSave}
          className="flex h-full min-h-0 flex-col"
        >
          {/* Header: title at top-left. Sheet renders its own close X. */}
          <div className="flex items-center gap-2 px-5 pt-5 pb-3">
            <SheetTitle className="truncate text-sm font-normal text-foreground">
              {titleText}
            </SheetTitle>
          </div>

          {/* Hero: solid pill-tone preview block. Color picker pill anchored
              bottom-right, matching SkillEditor's "Customize" affordance. */}
          <div
            className={cn(
              "relative shrink-0 overflow-hidden",
              HERO_HEIGHT_CLASS,
              heroToneClass,
            )}
          >
            <div className="absolute right-4 bottom-4">
              <ProjectColorPicker
                value={color}
                onChange={(tone: PillTone) => setColor(tone)}
              />
            </div>
          </div>

          {/* Scrollable form body. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted px-5 py-5">
            <div className={SECTION_GAP_CLASS}>
              <Label className={cn(FIELD_LABEL_CLASS, "text-foreground")}>
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
                className={PILL_INPUT_CLASS}
              />
            </div>

            <div className={SECTION_GAP_CLASS}>
              <Label className={FIELD_LABEL_CLASS}>
                {t("dialog.describeLabel")}
              </Label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("dialog.describePlaceholder")}
                rows={4}
                className={DESCRIPTION_TEXTAREA_CLASS}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className={SECTION_GAP_CLASS}>
                <Label className={FIELD_LABEL_CLASS}>
                  {t("dialog.folderLabel")}
                </Label>
                <button
                  type="button"
                  onClick={handleAddDirectory}
                  className={cn(
                    FIELD_INPUT_CLASS,
                    "flex w-full items-center gap-2 text-left",
                  )}
                >
                  <IconFolderPlus
                    className="size-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span
                    className={
                      folderDisplay
                        ? "truncate text-foreground"
                        : "truncate text-placeholder opacity-70"
                    }
                  >
                    {folderDisplay ?? t("dialog.folderPlaceholder")}
                  </span>
                </button>
              </div>

              <div className={SECTION_GAP_CLASS}>
                <Label className={FIELD_LABEL_CLASS}>
                  {t("dialog.modelLabel")}
                </Label>
                <Select
                  value={preferredProvider ?? "__none__"}
                  onValueChange={(v) =>
                    setPreferredProvider(v === "__none__" ? null : v)
                  }
                >
                  <SelectTrigger className={cn(FIELD_INPUT_CLASS, "w-full")}>
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
          <div className="flex shrink-0 items-center justify-end gap-2 bg-muted px-5 pb-5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClose}
              disabled={saving}
              className="h-8 rounded-full px-3"
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              form="project-form"
              size="sm"
              disabled={!canSave}
              className="h-8 rounded-full px-4"
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
