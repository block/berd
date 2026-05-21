import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  resolveSkillPillTone,
  skillPillToneClass,
} from "@/features/skills/lib/resolveSkillPillTone";
import {
  createSkill,
  updateSkill,
  type EditingSkill,
  type SkillInfo,
} from "../api/skills";
import { formatSkillName, isValidSkillName } from "../lib/skillsHelpers";
import { getRenamedSkillFileLocation } from "../lib/skillsPath";

/** Sentinel value for the "Global" option in the save-location picker. */
const GLOBAL_VALUE = "__global__";

// Shared visual constants for create/edit sheets. Mirrored in PersonaEditor —
// extract to a shared primitive once a third surface adopts the IA.
const SHEET_CONTENT_CLASS = "flex h-full flex-col gap-0 p-0 sm:max-w-[440px]";
const HERO_HEIGHT_CLASS = "h-[280px]";
const PILL_INPUT_CLASS =
  "h-10 rounded-full border-none bg-popover px-4 text-sm";
const FIELD_INPUT_CLASS =
  "h-10 rounded-[10px] border-none bg-popover px-4 text-sm";
const INSTRUCTIONS_TEXTAREA_CLASS =
  "min-h-[200px] resize-none rounded-[10px] border-none bg-popover px-4 py-3 font-mono text-xs leading-relaxed";
const FIELD_LABEL_CLASS = "text-[10px] text-muted-foreground";
const SECTION_GAP_CLASS = "space-y-1";

interface SkillEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (savedSkill?: SkillInfo) => void | Promise<void>;
  editingSkill?: EditingSkill;
  initialProjectId?: string | null;
  onDelete?: (editingSkill: EditingSkill) => void;
}

export function SkillEditor({
  isOpen,
  onClose,
  onSaved,
  editingSkill,
  initialProjectId,
  onDelete,
}: SkillEditorProps) {
  const { t } = useTranslation(["skills", "common"]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saveLocation, setSaveLocation] = useState(GLOBAL_VALUE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = useProjectStore((s) => s.projects);

  // Only projects with working directories can hold skills.
  const projectsWithDirs = useMemo(
    () => projects.filter((p) => p.workingDirs.length > 0),
    [projects],
  );

  const isEditing = !!editingSkill;
  const titleText = isEditing ? t("dialog.editTitle") : t("dialog.newTitle");

  // Pre-fill fields when editing.
  useEffect(() => {
    if (isOpen && editingSkill) {
      setName(editingSkill.name);
      setDescription(editingSkill.description);
      setInstructions(editingSkill.instructions);
      setSaveLocation(GLOBAL_VALUE);
      setError(null);
    } else if (isOpen) {
      setName("");
      setDescription("");
      setInstructions("");
      setSaveLocation(initialProjectId ?? GLOBAL_VALUE);
      setError(null);
    }
  }, [isOpen, editingSkill, initialProjectId]);

  const nameValid = isValidSkillName(name);
  const canSave = nameValid && description.trim().length > 0 && !saving;

  const handleNameChange = (raw: string) => {
    setName(formatSkillName(raw));
    setError(null);
  };

  const handleClose = () => {
    setName("");
    setDescription("");
    setInstructions("");
    setSaveLocation(GLOBAL_VALUE);
    setError(null);
    onClose();
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      let savedSkill: SkillInfo | undefined;
      if (isEditing) {
        savedSkill = await updateSkill(
          editingSkill.path,
          name,
          description.trim(),
          instructions,
        );
      } else {
        const projectId =
          saveLocation !== GLOBAL_VALUE ? saveLocation : undefined;
        await createSkill(name, description.trim(), instructions, {
          projectId,
        });
      }
      setName("");
      setDescription("");
      setInstructions("");
      setSaveLocation(GLOBAL_VALUE);
      await onSaved?.(savedSkill);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  // Pill-tone hero: deterministic from the current name (or "new" when empty
  // in create mode) so the color is stable across renders.
  const heroToneSeed = name || editingSkill?.name || "new";
  const heroToneClass = skillPillToneClass(resolveSkillPillTone(heroToneSeed));

  // Skills don't yet carry source metadata in this UI — the Figma "Built in"
  // tag is reserved for a later iteration. Hide until the model surfaces it.
  const isBuiltIn = false;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        className={SHEET_CONTENT_CLASS}
        aria-describedby={undefined}
      >
        <form
          id="skill-form"
          onSubmit={handleSave}
          className="flex h-full min-h-0 flex-col"
        >
          {/* Header: title + Built-in tag at top-left. Sheet renders its own
              close X in top-right. */}
          <div className="flex items-center gap-2 px-5 pt-5 pb-3">
            <SheetTitle className="truncate text-sm font-normal text-foreground">
              {titleText}
            </SheetTitle>
            {isBuiltIn ? (
              <span className="rounded-full bg-popover px-1.5 py-0.5 text-[11px] text-foreground">
                {t("dialog.builtIn")}
              </span>
            ) : null}
          </div>

          {/* Hero: solid pill-tone block. Customize pill anchored bottom-right. */}
          <div
            className={cn(
              "relative shrink-0 overflow-hidden",
              HERO_HEIGHT_CLASS,
              heroToneClass,
            )}
          >
            <button
              type="button"
              disabled
              title={t("dialog.customizeComingSoon")}
              className="absolute right-4 bottom-4 inline-flex h-8 items-center gap-1.5 rounded-full bg-popover px-3 text-sm text-foreground opacity-90 disabled:cursor-not-allowed"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("dialog.customize")}
            </button>
          </div>

          {/* Scrollable form body. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted px-5 py-5">
            <div className={SECTION_GAP_CLASS}>
              <Label className={FIELD_LABEL_CLASS}>
                {t("dialog.name")} <span className="text-destructive">*</span>
              </Label>
              <Input
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={t("dialog.namePlaceholder")}
                className={PILL_INPUT_CLASS}
              />
              {name.length > 0 && !nameValid ? (
                <p className="text-[11px] text-destructive">
                  {t("dialog.nameValidation")}
                </p>
              ) : null}
            </div>

            <div className={SECTION_GAP_CLASS}>
              <Label className={FIELD_LABEL_CLASS}>
                {t("dialog.description")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <Input
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setError(null);
                }}
                placeholder={t("dialog.descriptionPlaceholder")}
                className={FIELD_INPUT_CLASS}
              />
            </div>

            {isEditing && editingSkill ? (
              <p className="-mt-2 break-all text-[11px] text-muted-foreground">
                {t("dialog.pathOnDisk")}:{" "}
                {getRenamedSkillFileLocation(editingSkill.fileLocation, name)}
              </p>
            ) : null}

            {!isEditing && projectsWithDirs.length > 0 ? (
              <div className={SECTION_GAP_CLASS}>
                <Label className={FIELD_LABEL_CLASS}>
                  {t("dialog.saveLocation")}
                </Label>
                <Select value={saveLocation} onValueChange={setSaveLocation}>
                  <SelectTrigger className={cn(FIELD_INPUT_CLASS, "w-full")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={GLOBAL_VALUE}>
                      {t("dialog.global")}
                    </SelectItem>
                    {projectsWithDirs.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {saveLocation === GLOBAL_VALUE
                    ? t("dialog.globalHint")
                    : t("dialog.projectHint")}
                </p>
              </div>
            ) : null}

            <div className={SECTION_GAP_CLASS}>
              <Label className={FIELD_LABEL_CLASS}>
                {t("dialog.instructions")}
              </Label>
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={10}
                placeholder={t("dialog.instructionsPlaceholder")}
                className={INSTRUCTIONS_TEXTAREA_CLASS}
              />
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          {/* Footer: Delete + Duplicate (left, edit mode only) + Save
              Changes/Create (right). */}
          <div className="flex shrink-0 items-center justify-between gap-2 bg-muted px-5 pb-5">
            <div className="flex items-center gap-2">
              {isEditing && editingSkill && onDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(editingSkill)}
                  aria-label={t("common:actions.delete")}
                  className="h-8 rounded-full px-3 text-destructive hover:bg-popover hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("common:actions.delete")}
                </Button>
              ) : null}
              {/* Duplicate isn't yet wired through the skills API — render the
                  pill as a visual scaffold only in edit mode, disabled. */}
              {isEditing ? (
                <Button
                  type="button"
                  size="sm"
                  disabled
                  title={t("dialog.customizeComingSoon")}
                  className="h-8 rounded-full bg-popover px-3 text-foreground hover:bg-popover/90"
                >
                  <Copy className="h-3 w-3" />
                  {t("dialog.duplicate")}
                </Button>
              ) : null}
            </div>
            <Button
              type="submit"
              form="skill-form"
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
                  : t("dialog.createSkill")}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
