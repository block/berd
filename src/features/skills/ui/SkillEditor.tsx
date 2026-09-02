import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Copy, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
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
import { Button, buttonVariants } from "@/shared/ui/button";
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
import { ProjectColorPicker } from "@/features/projects/ui/ProjectColorPicker";
import { isHexColor } from "@/features/projects/lib/customPillColor";
import { pillCssColor } from "@/features/projects/lib/pillTones";
import { resolveSkillPillTone } from "@/features/skills/lib/resolveSkillPillTone";
import {
  createSkill,
  updateSkill,
  type EditingSkill,
  type SkillInfo,
} from "../api/skills";
import { formatSkillName, isValidSkillName } from "../lib/skillsHelpers";
import { getRenamedSkillFileLocation } from "../lib/skillsPath";

/** Sentinel value for the personal (`~/.agents/skills`) save location. */
const GLOBAL_VALUE = "__global__";

// Shared visual constants for create/edit sheets.
const SHEET_CONTENT_CLASS =
  "top-3 right-3 bottom-3 h-auto w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-lg bg-surface-editor-panel p-0 shadow-[var(--shadow-modal)] backdrop-blur-2xl sm:top-5 sm:right-5 sm:bottom-5 sm:w-[560px] sm:max-w-none";
const CLOSE_BUTTON_CLASS =
  "top-5 right-5 rounded-full bg-transparent opacity-80 hover:bg-[var(--surface-editor-control-hover)]";
const FIELD_INPUT_CLASS =
  "h-editor-field rounded-sm border-0 bg-[var(--surface-editor-control)] px-3.5 py-0 text-body-alex leading-editor-field text-foreground shadow-none outline-none transition-[box-shadow,background-color] duration-200 placeholder:text-[color:var(--text-editor-field-placeholder)] hover:shadow-[var(--shadow-editor-field-focus)] focus:shadow-[var(--shadow-editor-field-focus)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[var(--shadow-editor-field-focus)]";
const SELECT_TRIGGER_CLASS =
  "!h-editor-field min-h-editor-field rounded-sm border-0 bg-[var(--surface-editor-control)] px-3.5 py-0 text-body-alex leading-editor-field text-foreground shadow-none outline-none transition-[box-shadow,background-color] duration-200 data-[placeholder]:text-[color:var(--text-editor-field-placeholder)] data-[size=default]:!h-editor-field hover:shadow-[var(--shadow-editor-field-focus)] focus:shadow-[var(--shadow-editor-field-focus)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[var(--shadow-editor-field-focus)] data-[state=open]:shadow-[var(--shadow-editor-field-focus)]";
// Instructions stay monospace because the field holds markdown the agent
// reads literally. Height comes from the parent section's
// flex-grow so the textarea owns whatever vertical space the form body has
// after the other fields, falling back to a 215px floor on short windows.
const INSTRUCTIONS_TEXTAREA_CLASS =
  "h-full min-h-editor-instructions-min w-full resize-none rounded-sm border-0 bg-[var(--surface-editor-control)] px-3.5 py-[13px] font-mono text-editor-mono leading-relaxed text-foreground shadow-none outline-none transition-[box-shadow,background-color] duration-200 placeholder:text-[color:var(--text-editor-field-placeholder)] hover:shadow-[var(--shadow-editor-field-hover)] focus:shadow-[var(--shadow-editor-field-hover)] focus:outline-none";
const FIELD_LABEL_CLASS =
  "text-[10px] leading-3 font-normal text-muted-foreground transition-colors group-hover/field:text-foreground group-focus-within/field:text-foreground";
const SECTION_GAP_CLASS = "group/field space-y-2";
const ERROR_CALLOUT_CLASS =
  "flex items-start gap-2 rounded-sm border border-destructive/15 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 shadow-none";

type SkillEditorError =
  | { kind: "nameConflict"; sourceName: string }
  | { kind: "save"; message: string };

function getDuplicateSourceName(message: string): string | null {
  const match = message.match(
    /^A source named (?:"([^"]+)"|'([^']+)') already exists\.?$/i,
  );
  return match?.[1] ?? match?.[2] ?? null;
}

function normalizeDescription(description: string): string {
  return description.trim();
}

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
  const [error, setError] = useState<SkillEditorError | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [formHasScrollBelow, setFormHasScrollBelow] = useState(false);
  // null = "no explicit pick yet"; the hero falls through to the deterministic
  // name-hash tone so the editor still has visual identity before the user
  // clicks a swatch. Once they pick (or edit a skill with a stored color),
  // this holds the chosen tone and name renames no longer shift the hero.
  const [color, setColor] = useState<string | null>(null);
  const formBodyRef = useRef<HTMLDivElement>(null);

  const projects = useProjectStore((s) => s.projects);

  // Only projects with working directories can hold skills.
  const projectsWithDirs = useMemo(
    () => projects.filter((p) => p.workingDirs.length > 0),
    [projects],
  );

  const isEditing = !!editingSkill;
  const titleText = isEditing ? t("dialog.editTitle") : t("dialog.newTitle");

  // Pre-fill fields when editing.
  const editorResetKey = isOpen
    ? `${editingSkill?.path ?? "new"}\u0000${initialProjectId ?? ""}`
    : "closed";
  const [previousEditorResetKey, setPreviousEditorResetKey] =
    useState("uninitialized");
  if (previousEditorResetKey !== editorResetKey) {
    setPreviousEditorResetKey(editorResetKey);
    if (isOpen && editingSkill) {
      setName(editingSkill.name);
      setDescription(editingSkill.description);
      setInstructions(editingSkill.instructions);
      setSaveLocation(GLOBAL_VALUE);
      // Load stored color if present; otherwise leave null so the hero
      // tracks the deterministic name-hash and the user sees the same color
      // the cards in SkillsView show.
      setColor(editingSkill.color ?? null);
      setError(null);
      setDiscardDialogOpen(false);
    } else if (isOpen) {
      setName("");
      setDescription("");
      setInstructions("");
      setSaveLocation(initialProjectId ?? GLOBAL_VALUE);
      setColor(null);
      setError(null);
      setDiscardDialogOpen(false);
    } else {
      setDiscardDialogOpen(false);
    }
  }

  const initialName = editingSkill?.name ?? "";
  const initialDescription = editingSkill?.description ?? "";
  const initialInstructions = editingSkill?.instructions ?? "";
  const initialSaveLocation = editingSkill
    ? GLOBAL_VALUE
    : (initialProjectId ?? GLOBAL_VALUE);
  const initialColor = editingSkill?.color ?? null;
  const heroToneSeed = name || editingSkill?.name || "new";
  const currentEffectiveColor = color ?? resolveSkillPillTone(heroToneSeed);
  const isDirty =
    name !== initialName ||
    normalizeDescription(description) !==
      normalizeDescription(initialDescription) ||
    instructions !== initialInstructions ||
    saveLocation !== initialSaveLocation ||
    color !== initialColor;

  const nameValid = isValidSkillName(name);
  const canSave =
    nameValid && normalizeDescription(description).length > 0 && !saving;
  const showNameValidationError = name.length > 0 && !nameValid;
  const nameInputDescribedBy = [
    showNameValidationError ? "skill-name-validation" : null,
    error?.kind === "nameConflict" ? "skill-name-conflict" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const handleNameChange = (raw: string) => {
    setName(formatSkillName(raw));
    setError(null);
  };

  const clearSaveError = () => {
    setError((current) => (current?.kind === "nameConflict" ? current : null));
  };

  const discardAndClose = () => {
    setDiscardDialogOpen(false);
    setName("");
    setDescription("");
    setInstructions("");
    setSaveLocation(GLOBAL_VALUE);
    setColor(null);
    setError(null);
    onClose();
  };

  const requestClose = () => {
    if (saving) return;
    if (isDirty) {
      setDiscardDialogOpen(true);
      return;
    }
    discardAndClose();
  };

  // Effective tone: user pick wins, otherwise derive from the seed. Same
  // resolver used by SkillsView cards so an unpicked skill shows identical
  // color in both surfaces.
  const effectiveColor = currentEffectiveColor;
  const fallbackPanelTone = resolveSkillPillTone(heroToneSeed);
  const selectedPanelColor =
    pillCssColor(effectiveColor) ??
    (isHexColor(effectiveColor) ? effectiveColor : null) ??
    pillCssColor(fallbackPanelTone) ??
    "var(--surface-editor-panel-neutral)";

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
          normalizeDescription(description),
          instructions,
          effectiveColor,
        );
      } else {
        const projectId =
          saveLocation !== GLOBAL_VALUE ? saveLocation : undefined;
        savedSkill = await createSkill(
          name,
          normalizeDescription(description),
          instructions,
          effectiveColor,
          { projectId },
        );
      }
      setName("");
      setDescription("");
      setInstructions("");
      setSaveLocation(GLOBAL_VALUE);
      setColor(null);
      await onSaved?.(savedSkill);
      onClose();
    } catch (err) {
      const message = formatAcpErrorMessage(err);
      const duplicateSourceName = getDuplicateSourceName(message);
      setError(
        duplicateSourceName
          ? { kind: "nameConflict", sourceName: duplicateSourceName }
          : { kind: "save", message },
      );
    } finally {
      setSaving(false);
    }
  };

  const updateFooterDivider = useCallback(() => {
    const formBody = formBodyRef.current;
    if (!formBody) {
      setFormHasScrollBelow(false);
      return;
    }

    setFormHasScrollBelow(
      formBody.scrollHeight - formBody.scrollTop - formBody.clientHeight > 1,
    );
  }, []);

  if (!isOpen && formHasScrollBelow) {
    setFormHasScrollBelow(false);
  }

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(updateFooterDivider);
    window.addEventListener("resize", updateFooterDivider);
    const formBody = formBodyRef.current;
    let mutationObserver: MutationObserver | null = null;
    if (formBody) {
      mutationObserver = new MutationObserver(updateFooterDivider);
      mutationObserver.observe(formBody, { childList: true, subtree: true });
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateFooterDivider);
      mutationObserver?.disconnect();
    };
  }, [isOpen, updateFooterDivider]);

  // Skills don't yet carry source metadata in this UI — the Figma "Built in"
  // tag is reserved for a later iteration. Hide until the model surfaces it.
  const isBuiltIn = false;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && requestClose()}>
      <SheetContent
        className={SHEET_CONTENT_CLASS}
        closeButtonClassName={CLOSE_BUTTON_CLASS}
        overlayClassName="bg-transparent"
        style={{
          backgroundColor: `color-mix(in oklab, ${selectedPanelColor} 26%, transparent)`,
        }}
        aria-describedby={undefined}
      >
        <form
          id="skill-form"
          onSubmit={handleSave}
          className="flex h-full min-h-0 flex-col"
        >
          {/* Header: title at top-left. Sheet renders its own close X in
              top-right. */}
          <div className="flex items-center gap-2 px-8 pt-5 pb-2 pr-16">
            <SheetTitle className="truncate text-sm font-normal text-foreground">
              {titleText}
            </SheetTitle>
            {isBuiltIn ? (
              <span className="rounded-xs bg-[var(--surface-editor-badge)] px-1.5 py-0.5 text-[11px] text-foreground">
                {t("dialog.builtIn")}
              </span>
            ) : null}
          </div>

          {/* Color well: centered below the title so the color choice feels like
              the skill's visual identity, similar to the project editor preview
              area, without restoring the old giant color block. */}
          <div className="flex shrink-0 justify-center px-8 pt-7 pb-5">
            <ProjectColorPicker
              variant="swatches"
              value={effectiveColor}
              onChange={setColor}
            />
          </div>

          {/* Scrollable form body. */}
          <div
            ref={formBodyRef}
            onScroll={updateFooterDivider}
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto bg-transparent px-6 py-5 sm:px-8"
          >
            <div className={SECTION_GAP_CLASS}>
              <Label className={FIELD_LABEL_CLASS}>
                {t("dialog.name")} <span className="text-destructive">*</span>
              </Label>
              <Input
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={t("dialog.namePlaceholder")}
                className={FIELD_INPUT_CLASS}
                aria-invalid={
                  showNameValidationError || error?.kind === "nameConflict"
                }
                aria-describedby={nameInputDescribedBy || undefined}
              />
              {showNameValidationError ? (
                <p
                  id="skill-name-validation"
                  className="text-[11px] text-destructive"
                >
                  {t("dialog.nameValidation")}
                </p>
              ) : null}
              {error?.kind === "nameConflict" ? (
                <div
                  id="skill-name-conflict"
                  role="alert"
                  className={ERROR_CALLOUT_CLASS}
                >
                  <AlertCircle
                    aria-hidden="true"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                  />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {t("dialog.nameConflictTitle", {
                        name: error.sourceName,
                      })}
                    </p>
                    <p className="text-muted-foreground">
                      {t("dialog.nameConflictDescription")}
                    </p>
                  </div>
                </div>
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
                  clearSaveError();
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
                <Select
                  value={saveLocation}
                  onValueChange={(value) => {
                    setSaveLocation(value);
                    clearSaveError();
                  }}
                >
                  <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, "w-full")}>
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
              </div>
            ) : null}

            {error?.kind === "save" ? (
              <div role="alert" className={ERROR_CALLOUT_CLASS}>
                <AlertCircle
                  aria-hidden="true"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {t("dialog.saveErrorTitle")}
                  </p>
                  <p className="break-words text-muted-foreground">
                    {error.message}
                  </p>
                </div>
              </div>
            ) : null}

            <div
              className={cn(SECTION_GAP_CLASS, "flex min-h-0 flex-1 flex-col")}
            >
              <Label className={FIELD_LABEL_CLASS}>
                {t("dialog.instructions")}
              </Label>
              <Textarea
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value);
                  clearSaveError();
                }}
                placeholder={t("dialog.instructionsPlaceholder")}
                className={INSTRUCTIONS_TEXTAREA_CLASS}
              />
            </div>
          </div>

          {/* Footer: Delete + Duplicate (left, edit mode only) + Save
              Changes/Create (right). */}
          <div
            className={cn(
              "flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-transparent px-6 pt-4 pb-7 transition-[border-color,box-shadow] duration-200 sm:px-8",
              formHasScrollBelow
                ? "border-[color:var(--border-editor-divider)] shadow-[var(--shadow-editor-footer)]"
                : "border-transparent shadow-none",
            )}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {isEditing && editingSkill && onDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(editingSkill)}
                  aria-label={t("common:actions.delete")}
                  className="h-10 rounded-full px-4 text-sm text-destructive hover:bg-[var(--surface-editor-control-hover)] hover:text-destructive"
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
                  tooltip={t("dialog.customizeComingSoon")}
                  className="h-10 rounded-full bg-[var(--surface-editor-control)] px-4 text-sm text-foreground hover:bg-[color-mix(in_oklab,var(--surface-editor-control)_90%,transparent)]"
                >
                  <Copy className="h-3 w-3" />
                  {t("dialog.duplicate")}
                </Button>
              ) : null}
            </div>
            <div className="ml-auto flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={requestClose}
                disabled={saving}
                className="h-10 rounded-full px-4 text-sm hover:bg-[var(--surface-editor-control-hover)]"
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                form="skill-form"
                size="sm"
                disabled={!canSave}
                className="h-10 rounded-full bg-foreground px-5 text-sm text-background hover:bg-foreground/90 disabled:bg-foreground disabled:text-background"
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
          </div>
        </form>
      </SheetContent>

      <AlertDialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialog.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialog.discardDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dialog.keepEditing")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({
                variant: "primary",
                destructive: true,
              })}
              onClick={discardAndClose}
            >
              {t("dialog.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
