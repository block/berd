import { ArrowRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import type { WidgetRenderProps } from "./types";

const ONBOARDING_NOTE_CONTENT = {
  "onboarding:welcome": {
    tone: "peach",
    titleKey: "widgets.stickyNote.notes.welcome.title",
    bodyKey: "widgets.stickyNote.notes.welcome.body",
  },
  "onboarding:build-agent": {
    tone: "warm",
    titleKey: "widgets.stickyNote.notes.buildAgent.title",
    bodyKey: "widgets.stickyNote.notes.buildAgent.body",
    actionKey: "widgets.stickyNote.notes.buildAgent.action",
    action: "createPersona",
  },
  "onboarding:start-project": {
    tone: "cool",
    titleKey: "widgets.stickyNote.notes.startProject.title",
    bodyKey: "widgets.stickyNote.notes.startProject.body",
    actionKey: "widgets.stickyNote.notes.startProject.action",
    action: "createProject",
  },
  "onboarding:reuse-workflows": {
    tone: "rose",
    titleKey: "widgets.stickyNote.notes.skills.title",
    bodyKey: "widgets.stickyNote.notes.skills.body",
    actionKey: "widgets.stickyNote.notes.skills.action",
    action: "openSkills",
  },
  "onboarding:shape-home": {
    tone: "blue",
    titleKey: "widgets.stickyNote.notes.shapeHome.title",
    bodyKey: "widgets.stickyNote.notes.shapeHome.body",
  },
  "onboarding:manage-automations": {
    tone: "lavender",
    titleKey: "widgets.stickyNote.notes.automations.title",
    bodyKey: "widgets.stickyNote.notes.automations.body",
    actionKey: "widgets.stickyNote.notes.automations.action",
    action: "openAutomations",
  },
} as const;

type OnboardingNoteId = keyof typeof ONBOARDING_NOTE_CONTENT;

function getNoteId(state: Record<string, unknown> | undefined) {
  return typeof state?.noteId === "string" ? state.noteId : null;
}

function isOnboardingNoteId(noteId: string | null): noteId is OnboardingNoteId {
  return noteId != null && noteId in ONBOARDING_NOTE_CONTENT;
}

export function StickyNoteWidget({
  instance,
  onCreatePersona,
  onCreateProject,
  onOpenSkills,
  onOpenAutomations,
  onRemoveWidget,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const noteId = getNoteId(instance.state);
  const note = isOnboardingNoteId(noteId)
    ? ONBOARDING_NOTE_CONTENT[noteId]
    : ONBOARDING_NOTE_CONTENT["onboarding:build-agent"];
  const onAction =
    "action" in note
      ? note.action === "createPersona"
        ? onCreatePersona
        : note.action === "createProject"
          ? onCreateProject
          : note.action === "openSkills"
            ? onOpenSkills
            : onOpenAutomations
      : null;
  const actionLabel = "actionKey" in note ? t(note.actionKey) : null;

  return (
    <section
      aria-label={t("widgets.stickyNote.label")}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-xs px-4 pb-4 pt-5 text-sticky-note-foreground shadow-sticky-note",
        note.tone === "warm"
          ? "bg-sticky-note-warm"
          : note.tone === "cool"
            ? "bg-sticky-note-cool"
            : note.tone === "rose"
              ? "bg-sticky-note-rose"
              : note.tone === "blue"
                ? "bg-sticky-note-blue"
                : note.tone === "lavender"
                  ? "bg-sticky-note-lavender"
                  : "bg-sticky-note-peach",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("widgets.stickyNote.dismiss")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemoveWidget?.();
        }}
        className="absolute top-2 right-2 z-20 text-sticky-note-muted hover:text-sticky-note-foreground"
      >
        <X aria-hidden="true" />
      </Button>
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <p className="pr-6 text-[15px] font-medium leading-5">
          {t(note.titleKey)}
        </p>
        <p className="mt-1.5 text-xs leading-4 text-sticky-note-muted">
          {t(note.bodyKey)}
        </p>
        {onAction && actionLabel ? (
          <Button
            type="button"
            size="xs"
            onClick={onAction}
            className="mt-auto h-7 self-start px-3"
            rightIcon={<ArrowRight aria-hidden="true" />}
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
