import { useState, useCallback, useEffect } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { IconPlus, IconUpload } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/shared/ui/button";
import { PageShell } from "@/shared/ui/page-shell";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
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
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  selectPersonas,
  selectPersonasLoading,
} from "@/features/agents/stores/agentSelectors";
import { AgentDetailPage } from "@/features/agents/ui/AgentDetailPage";
import { PersonaGallery } from "@/features/agents/ui/PersonaGallery";
import {
  exportPersona,
  importPersonas,
  readImportPersonaFile,
} from "@/shared/api/agents";
import { usePersonas } from "@/features/agents/hooks/usePersonas";
import type { Persona } from "@/shared/types/agents";
import {
  formatAgentError,
  formatImportSuccessMessage,
  formatPersonaImportFileSize,
  MAX_PERSONA_IMPORT_BYTES,
  validatePersonaImportFile,
} from "@/features/agents/lib/personaImport";
import { canDeletePersona } from "@/features/agents/lib/personaPresentation";
import type { AppNavigationUpdateOptions } from "@/app/types/appNavigation";

function decodeImportFileBytes(fileBytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(fileBytes),
    );
  } catch {
    throw new Error("File is not valid UTF-8 text");
  }
}

function sourcePathToSlug(pathOrId: string): string {
  const baseName = pathOrId.split(/[\\/]/).pop() ?? pathOrId;
  const lowerName = baseName.toLowerCase();
  if (lowerName.endsWith(".persona.md")) {
    return baseName.slice(0, -".persona.md".length);
  }
  return lowerName.endsWith(".md") ? baseName.slice(0, -3) : baseName;
}

interface AgentsViewProps {
  activePersonaId?: string | null;
  onActivePersonaIdChange?: (
    personaId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onBreadcrumbLabelChange?: (label: string | null) => void;
  onStartAgentBuilderSession?: (args?: { slug?: string }) => void;
}

export function AgentsView({
  activePersonaId,
  onActivePersonaIdChange,
  onBreadcrumbLabelChange,
  onStartAgentBuilderSession,
}: AgentsViewProps = {}) {
  const { t } = useTranslation(["agents", "common"]);
  const isActivePersonaControlled = activePersonaId !== undefined;
  const [deletingPersona, setDeletingPersona] = useState<Persona | null>(null);
  const [internalActivePersonaId, setInternalActivePersonaId] = useState<
    string | null
  >(null);

  const personas = useAgentStore(selectPersonas);
  const personasLoading = useAgentStore(selectPersonasLoading);
  const shouldReduceMotion = useReducedMotion();
  // Four or fewer agents fit in a single screen, so we float the grid in the
  // vertical center; the fifth makes the grid taller, so it returns to the top
  // and scrolls. The motion layout animation slides it up/down across that line.
  const isVerticallyCentered = !personasLoading && personas.length <= 4;

  const { createPersona, deletePersona, refreshFromDisk } = usePersonas();

  const currentActivePersonaId = isActivePersonaControlled
    ? activePersonaId
    : internalActivePersonaId;
  const activePersona =
    personas.find((persona) => persona.id === currentActivePersonaId) ?? null;

  useEffect(() => {
    onBreadcrumbLabelChange?.(activePersona?.displayName ?? null);
  }, [activePersona?.displayName, onBreadcrumbLabelChange]);

  useEffect(() => {
    return () => onBreadcrumbLabelChange?.(null);
  }, [onBreadcrumbLabelChange]);

  const setActivePersona = useCallback(
    (personaId: string | null, options?: AppNavigationUpdateOptions) => {
      if (!isActivePersonaControlled) {
        setInternalActivePersonaId(personaId);
      }
      onActivePersonaIdChange?.(personaId, options);
    },
    [isActivePersonaControlled, onActivePersonaIdChange],
  );

  const handleSelectPersona = useCallback(
    (persona: Persona) => setActivePersona(persona.id),
    [setActivePersona],
  );

  const handleEditPersona = useCallback(
    (persona: Persona) => {
      onStartAgentBuilderSession?.({ slug: sourcePathToSlug(persona.id) });
    },
    [onStartAgentBuilderSession],
  );

  const handleCreatePersona = useCallback(() => {
    onStartAgentBuilderSession?.({});
  }, [onStartAgentBuilderSession]);

  useEffect(() => {
    if (
      currentActivePersonaId &&
      !personasLoading &&
      personas.length > 0 &&
      !activePersona
    ) {
      setActivePersona(null, { replace: true });
    }
  }, [
    activePersona,
    currentActivePersonaId,
    personas.length,
    personasLoading,
    setActivePersona,
  ]);

  const handleDuplicatePersona = useCallback(
    async (persona: Persona) => {
      try {
        await createPersona({
          displayName: t("view.copyName", { name: persona.displayName }),
          avatar: persona.avatar ?? undefined,
          systemPrompt: persona.systemPrompt,
          provider: persona.provider,
          model: persona.model,
        });
        toast.success(t("editor.duplicated"));
      } catch (error) {
        toast.error(formatAgentError(error, t("editor.saveFailed")));
      }
    },
    [createPersona, t],
  );

  const handleDeletePersona = useCallback((persona: Persona) => {
    if (!canDeletePersona(persona)) return;
    setDeletingPersona(persona);
  }, []);

  const handleConfirmDeletePersona = useCallback(async () => {
    if (!deletingPersona) return;
    try {
      await deletePersona(deletingPersona.id);
      if (currentActivePersonaId === deletingPersona.id) {
        setActivePersona(null, { replace: true });
      }
      toast.success(t("view.deleted", { name: deletingPersona.displayName }));
    } catch (err) {
      toast.error(formatAgentError(err, t("view.deleteFailed")));
    }
    setDeletingPersona(null);
  }, [
    currentActivePersonaId,
    deletingPersona,
    deletePersona,
    setActivePersona,
    t,
  ]);

  const handleExportPersona = useCallback(
    async (persona: Persona) => {
      try {
        const result = await exportPersona(persona.id);
        const blob = new Blob([result.contents], { type: result.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success(t("view.exportedTo", { filename: result.filename }));
      } catch (err) {
        toast.error(formatAgentError(err, t("view.exportFailed")));
      }
    },
    [t],
  );

  const handleImportError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  const validateImportFile = useCallback(
    (file: Pick<File, "name" | "type" | "size">) => {
      const message = validatePersonaImportFile(file);
      return message ? t(message.key, message.options) : null;
    },
    [t],
  );

  const handleImportContents = useCallback(
    async (fileContents: string, fileName: string) => {
      try {
        const imported = await importPersonas(fileContents, fileName);
        await refreshFromDisk();
        const message = formatImportSuccessMessage(imported.length);
        toast.success(t(message.key, message.options));
      } catch (err) {
        toast.error(formatAgentError(err, t("view.importFailed")));
      }
    },
    [refreshFromDisk, t],
  );

  const handleImportFileBytes = useCallback(
    async (fileBytes: number[], fileName: string) => {
      try {
        await handleImportContents(decodeImportFileBytes(fileBytes), fileName);
      } catch (err) {
        toast.error(formatAgentError(err, t("view.importFailed")));
      }
    },
    [handleImportContents, t],
  );

  const setTopBarActions = useSetTopBarActions();

  const handleImportPicker = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: t("common:actions.import"),
        filters: [
          {
            name: "Agent",
            extensions: ["md", "json"],
          },
        ],
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      const { fileContents, fileName } = await readImportPersonaFile(selected);
      const validationMessage = validateImportFile({
        name: fileName,
        type: "",
        size: new TextEncoder().encode(fileContents).byteLength,
      });

      if (validationMessage) {
        toast.error(validationMessage);
        return;
      }

      await handleImportContents(fileContents, fileName);
    } catch (err) {
      toast.error(formatAgentError(err, t("view.importFailed")));
    }
  }, [handleImportContents, t, validateImportFile]);

  useEffect(() => {
    if (activePersona) {
      setTopBarActions(null);
      return;
    }
    setTopBarActions(
      <>
        <Button
          type="button"
          variant="page-header"
          size="xs"
          onClick={() => void handleImportPicker()}
          leftIcon={<IconUpload />}
        >
          {t("common:actions.import")}
        </Button>
        <Button
          type="button"
          variant="page-header"
          size="xs"
          onClick={handleCreatePersona}
          leftIcon={<IconPlus />}
        >
          {t("view.newPersona")}
        </Button>
      </>,
    );
    return () => setTopBarActions(null);
  }, [
    activePersona,
    handleImportPicker,
    handleCreatePersona,
    setTopBarActions,
    t,
  ]);

  const dialogs = (
    <>
      <AlertDialog
        open={!!deletingPersona}
        onOpenChange={(open) => !open && setDeletingPersona(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("view.deleteTitle", {
                name: deletingPersona?.displayName ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("view.deleteDescription", {
                name: deletingPersona?.displayName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleConfirmDeletePersona}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  if (activePersona) {
    return (
      <>
        <AgentDetailPage
          persona={activePersona}
          onBack={() => setActivePersona(null)}
          onEdit={handleEditPersona}
          onDuplicate={handleDuplicatePersona}
          onDelete={handleDeletePersona}
          onExport={handleExportPersona}
        />
        {dialogs}
      </>
    );
  }

  return (
    <PageShell
      contentWidth="full"
      contentAlign={isVerticallyCentered ? "center" : "top"}
    >
      <motion.section
        layout="position"
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : { type: "spring", bounce: 0, duration: 0.4 }
        }
        aria-labelledby="personas-heading"
      >
        <PersonaGallery
          personas={personas}
          onSelectPersona={handleSelectPersona}
          onEditPersona={handleEditPersona}
          onDuplicatePersona={handleDuplicatePersona}
          onDeletePersona={handleDeletePersona}
          onExportPersona={handleExportPersona}
          onCreatePersona={handleCreatePersona}
          onImportFile={handleImportFileBytes}
          validateImportFile={validateImportFile}
          onImportError={handleImportError}
          maxImportBytes={MAX_PERSONA_IMPORT_BYTES}
          importTooLargeMessage={t("view.importTooLarge", {
            maxSize: formatPersonaImportFileSize(MAX_PERSONA_IMPORT_BYTES),
          })}
          isLoading={personasLoading}
        />
      </motion.section>

      {dialogs}
    </PageShell>
  );
}
