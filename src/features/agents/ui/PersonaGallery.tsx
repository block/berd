import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import type { Persona } from "@/shared/types/agents";
import { PersonaCard } from "@/features/agents/ui/PersonaCard";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";

interface PersonaGalleryProps {
  personas: Persona[];
  activePersonaId?: string;
  onSelectPersona: (persona: Persona) => void;
  onEditPersona: (persona: Persona) => void;
  onDuplicatePersona: (persona: Persona) => void;
  onDeletePersona: (persona: Persona) => void;
  onExportPersona?: (persona: Persona) => void;
  onCreatePersona: () => void;
  onImportFile?: (fileBytes: number[], fileName: string) => void;
  validateImportFile?: (
    file: Pick<File, "name" | "type" | "size">,
  ) => string | null;
  onImportError?: (message: string) => void;
  maxImportBytes?: number;
  importTooLargeMessage?: string;
  isLoading?: boolean;
}

function SkeletonCard() {
  return (
    <div aria-hidden="true" className="flex w-full flex-col gap-4 p-2">
      <Skeleton className="aspect-square w-full rounded-card-sm" />
      <div className="space-y-3 px-1">
        <Skeleton className="h-px w-full rounded-none" />
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}

export function PersonaGallery({
  personas,
  activePersonaId,
  onSelectPersona,
  onEditPersona,
  onDuplicatePersona,
  onDeletePersona,
  onExportPersona,
  onCreatePersona,
  onImportFile,
  validateImportFile,
  onImportError,
  maxImportBytes,
  importTooLargeMessage,
  isLoading = false,
}: PersonaGalleryProps) {
  const { t } = useTranslation("agents");
  const { fileInputRef, isDragOver, dropHandlers, handleFileChange } =
    useFileImportZone({
      onImportFile: onImportFile ?? (() => {}),
      validateFile: validateImportFile,
      onImportError,
      maxBytes: maxImportBytes,
      fileTooLargeMessage: importTooLargeMessage,
    });

  const sorted = useMemo(() => {
    const builtins = personas
      .filter((p) => p.isBuiltin)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const custom = personas
      .filter((p) => !p.isBuiltin)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return [...builtins, ...custom];
  }, [personas]);

  // Cards stay a fixed size when the sidebar collapses; `justify-evenly`
  // distributes the extra width between and around them. Mirrors SkillsGrid.
  const gridClass = cn(
    "grid gap-x-8 gap-y-10",
    "grid-cols-2 sm:grid-cols-3",
    "xl:grid-cols-[repeat(4,minmax(0,16rem))] xl:justify-evenly",
  );

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label={t("gallery.loading")}
        className={gridClass}
      >
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (personas.length === 0) {
    return (
      <div
        {...dropHandlers}
        className={cn(
          "flex min-h-[calc(100dvh-12rem)] flex-col items-center px-6 pt-10 pb-12",
          isDragOver && "bg-muted/30",
        )}
      >
        <div className="flex w-full max-w-[359px] flex-col items-start text-left">
          <div className="space-y-1">
            <h2
              id="personas-heading"
              className="font-display text-base font-normal leading-5 text-surface-agent-profile-fg"
            >
              {t("gallery.empty.aboutTitle")}
            </h2>
            <p className="text-base leading-5 text-surface-agent-profile-fg-subtle">
              {t("gallery.empty.aboutDescription")}
            </p>
          </div>

          <div className="mt-[29px] space-y-1">
            <h3 className="font-display text-base font-normal leading-5 text-surface-agent-profile-fg">
              {t("gallery.empty.valueTitle")}
            </h3>
            <p className="text-base leading-5 text-surface-agent-profile-fg-subtle">
              {t("gallery.empty.valueDescription")}
            </p>
          </div>

          <Button
            type="button"
            aria-label={t("gallery.createAria")}
            onClick={onCreatePersona}
            className="mt-[35px] bg-surface-agent-profile-fg text-sm leading-[15px] text-surface-agent-profile-action-fg hover:bg-surface-agent-profile-action-bg-hover"
          >
            {t("gallery.empty.createFirst")}
          </Button>
        </div>
        {onImportFile && (
          <input
            ref={fileInputRef}
            type="file"
            accept=".persona.md,.json,text/markdown,text/plain,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
        )}
      </div>
    );
  }

  return (
    <div {...dropHandlers} className={gridClass}>
      <button
        type="button"
        onClick={onCreatePersona}
        aria-label={t("gallery.createAria")}
        className={cn(
          "agents-gallery-card-enter group flex h-full w-full items-center justify-center rounded-card border border-transparent p-4",
          "text-muted-foreground transition-[background-color,backdrop-filter,border-color,color] duration-200",
          "hover:border-card/40 hover:bg-card/40 hover:text-foreground hover:backdrop-blur-sm",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <IconPlus className="size-8 stroke-[1.25]" aria-hidden="true" />
      </button>
      {sorted.map((persona, index) => (
        <div
          key={persona.id}
          className="agents-gallery-card-enter"
          style={{ animationDelay: `${(index + 1) * 115}ms` }}
        >
          <PersonaCard
            persona={persona}
            isActive={persona.id === activePersonaId}
            onSelect={onSelectPersona}
            onEdit={onEditPersona}
            onDuplicate={onDuplicatePersona}
            onDelete={onDeletePersona}
            onExport={onExportPersona}
          />
        </div>
      ))}
      {onImportFile && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".persona.md,.json,text/markdown,text/plain,application/json"
          className="hidden"
          onChange={handleFileChange}
        />
      )}
    </div>
  );
}
