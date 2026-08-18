import { useState, useCallback, useEffect, useMemo } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { buttonVariants } from "@/shared/ui/button";
import { PageShell } from "@/shared/ui/page-shell";
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
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  selectPersonas,
  selectPersonasLoading,
} from "@/features/agents/stores/agentSelectors";
import { AgentDetailPage } from "@/features/agents/ui/AgentDetailPage";
import { PersonaGallery } from "@/features/agents/ui/PersonaGallery";
import { AgentShareDialog } from "@/features/agents/ui/share-card";
import {
  exportPersona,
  importPersonas,
  previewPersonaImport,
} from "@/shared/api/agents";
import { saveExportedAgentFile } from "@/shared/api/system";
import {
  decodeAgentImage,
  getPngDimensions,
  MAX_SNAPSHOT_PNG_BYTES,
  type SnapshotV1,
} from "@/features/agents/agent-snapshot";
import { AgentImageImportDialog } from "@/features/agents/ui/AgentImageImportDialog";
import { AgentImportDialog } from "@/features/agents/ui/AgentImportDialog";
import { usePersonas } from "@/features/agents/hooks/usePersonas";
import type { Persona } from "@/shared/types/agents";
import {
  formatAgentError,
  formatImportSuccessMessage,
  formatPersonaImportFileSize,
  validatePersonaImportFile,
} from "@/features/agents/lib/personaImport";
import { isEmptyAgentsGallerySimulated } from "@/features/agents/lib/emptyGallerySimulation";
import { canDeletePersona } from "@/features/agents/lib/personaPresentation";
import {
  trackAgentCreateCompleted,
  trackAgentDeleteCompleted,
  trackAgentEditCompleted,
} from "@/features/agents/lib/agentTelemetry";
import { runAgentViewTransition } from "@/features/agents/lib/agentViewTransitions";
import { deleteDraftAgentSession } from "@/features/agents/lib/agentBuilderSession";
import type { AppNavigationUpdateOptions } from "@/app/types/appNavigation";
import { isSafePngAvatarDataUrl } from "@/shared/lib/avatarUrl";
import {
  AgentZipImportError,
  type ExtractedAgentFile,
  extractAgentFileFromZipInWorker,
  isAgentZipFileName,
} from "@/features/agents/lib/agentZipImport";

function decodeImportFileBytes(fileBytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
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

function isAgentImageFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".png");
}

function formatAgentZipImportError(
  error: AgentZipImportError,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (error.code === "tooLarge" && error.maxBytes) {
    return t("view.importTooLarge", {
      maxSize: formatPersonaImportFileSize(error.maxBytes),
    });
  }
  return t(`zipImport.${error.code}`);
}

function exportFilenameFromPath(
  path: string,
  fallbackFilename: string,
): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const filename = normalized.split("/").pop();
  return filename?.trim() ? filename : fallbackFilename;
}

interface AgentsViewProps {
  activePersonaId?: string | null;
  onActivePersonaIdChange?: (
    personaId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onBreadcrumbLabelChange?: (label: string | null) => void;
  onStartAgentBuilderSession?: (args?: {
    path?: string;
    slug?: string;
  }) => void;
  onStartChatWithAgent?: (personaId: string) => void;
  onDeleteDraftSession?: (sessionId: string) => void | Promise<void>;
}

export function AgentsView({
  activePersonaId,
  onActivePersonaIdChange,
  onBreadcrumbLabelChange,
  onStartAgentBuilderSession,
  onStartChatWithAgent,
  onDeleteDraftSession,
}: AgentsViewProps = {}) {
  const { t } = useTranslation(["agents", "common"]);
  const isActivePersonaControlled = activePersonaId !== undefined;
  const [deletingPersona, setDeletingPersona] = useState<Persona | null>(null);
  const [sharingPersonaId, setSharingPersonaId] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [galleryImportFile, setGalleryImportFile] = useState<{
    bytes: Uint8Array;
    name: string;
  } | null>(null);
  const [imageImport, setImageImport] = useState<{
    snapshot: SnapshotV1;
    bytes: Uint8Array;
  } | null>(null);
  const [internalActivePersonaId, setInternalActivePersonaId] = useState<
    string | null
  >(null);

  const storedPersonas = useAgentStore(selectPersonas);
  const personasLoading = useAgentStore(selectPersonasLoading);
  const sharingPersona = sharingPersonaId
    ? (storedPersonas.find((persona) => persona.id === sharingPersonaId) ??
      null)
    : null;
  // Dev-only simulation of the empty gallery onboarding state. See
  // emptyGallerySimulation.ts for how to toggle it from the console.
  const personas = useMemo(
    () => (isEmptyAgentsGallerySimulated() ? [] : storedPersonas),
    [storedPersonas],
  );
  const sessions = useChatSessionStore((state) => state.sessions);
  const agentDraftSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.intent === "build-agent" &&
          session.targetAgentDraftSaved === true &&
          !session.archivedAt &&
          Boolean(session.targetAgentPath),
      ),
    [sessions],
  );
  const shouldReduceMotion = useReducedMotion();
  // Four or fewer agents fit in a single screen, so we float the grid in the
  // vertical center; the fifth makes the grid taller, so it returns to the top
  // and scrolls. The motion layout animation slides it up/down across that line.
  const isVerticallyCentered = !personasLoading && personas.length <= 4;

  const {
    createPersona,
    updatePersona: updatePersonaViaHook,
    deletePersona,
    refreshFromDisk,
  } = usePersonas();

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
      const isReturningToGallery =
        Boolean(currentActivePersonaId) && !personaId;
      const applyActivePersonaChange = () => {
        if (!isActivePersonaControlled) {
          setInternalActivePersonaId(personaId);
        }
        onActivePersonaIdChange?.(personaId, options);
      };

      if (isReturningToGallery) {
        applyActivePersonaChange();
        return;
      }

      const transitionKind =
        !currentActivePersonaId && personaId
          ? "gallery-to-profile"
          : currentActivePersonaId && personaId
            ? "profile-to-profile"
            : undefined;

      runAgentViewTransition(applyActivePersonaChange, {
        kind: transitionKind,
      });
    },
    [
      currentActivePersonaId,
      isActivePersonaControlled,
      onActivePersonaIdChange,
    ],
  );

  const handleSelectPersona = useCallback(
    (persona: Persona) => setActivePersona(persona.id),
    [setActivePersona],
  );

  const handleStartChat = useCallback(
    (persona: Persona) => {
      onStartChatWithAgent?.(persona.id);
    },
    [onStartChatWithAgent],
  );

  const handleEditPersona = useCallback(
    (persona: Persona) => {
      onStartAgentBuilderSession?.({
        path: persona.id,
        slug: sourcePathToSlug(persona.id),
      });
    },
    [onStartAgentBuilderSession],
  );

  const handleCreatePersona = useCallback(() => {
    onStartAgentBuilderSession?.({});
  }, [onStartAgentBuilderSession]);

  const handleContinueDraft = useCallback(
    (sessionId: string) => {
      const session = useChatSessionStore.getState().getSession(sessionId);
      if (!session?.targetAgentPath) {
        return;
      }

      onStartAgentBuilderSession?.({
        path: session.targetAgentPath,
        slug: session.targetAgentSlug ?? undefined,
      });
    },
    [onStartAgentBuilderSession],
  );

  const handleDeleteDraft = useCallback(
    (sessionId: string) => {
      void deleteDraftAgentSession(sessionId, {
        closeSession: onDeleteDraftSession,
      }).catch((error) => {
        toast.error(formatAgentError(error, t("view.deleteFailed")));
      });
    },
    [onDeleteDraftSession, t],
  );

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
        const created = await createPersona({
          displayName: t("view.copyName", { name: persona.displayName }),
          avatar: persona.avatar ?? undefined,
          systemPrompt: persona.systemPrompt,
          provider: persona.provider,
          modelProviderId: persona.modelProviderId,
          model: persona.model,
        });
        // Completed on confirmed success, after the duplicate is persisted.
        trackAgentCreateCompleted({
          provider: created.provider,
          model: created.model,
        });
        toast.success(t("editor.duplicated"));
      } catch (error) {
        toast.error(formatAgentError(error, t("editor.saveFailed")));
      }
    },
    [createPersona, t],
  );

  const handleUpdateAvatar = useCallback(
    async (persona: Persona, avatar: string | null) => {
      try {
        const updated = await updatePersonaViaHook(persona, { avatar });
        // Completed on confirmed success, after the avatar edit persists.
        trackAgentEditCompleted({
          provider: updated.provider,
          model: updated.model,
        });
        toast.success(t("editor.updated"));
      } catch (error) {
        toast.error(formatAgentError(error, t("editor.saveFailed")));
        throw error;
      }
    },
    [t, updatePersonaViaHook],
  );

  const handleDeletePersona = useCallback((persona: Persona) => {
    if (!canDeletePersona(persona)) return;
    setDeletingPersona(persona);
  }, []);

  const handleSharePersona = useCallback((persona: Persona) => {
    setSharingPersonaId(persona.id);
  }, []);

  const handleConfirmDeletePersona = useCallback(async () => {
    if (!deletingPersona) return;
    try {
      await deletePersona(deletingPersona.id);
      // Completed on confirmed success, after the delete resolves.
      trackAgentDeleteCompleted();
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
        if (window.__TAURI_INTERNALS__) {
          const savedPath = await saveExportedAgentFile(
            result.filename,
            result.contents,
          );
          if (!savedPath) return;
          toast.success(
            t("view.exportedTo", {
              filename: exportFilenameFromPath(savedPath, result.filename),
            }),
          );
          return;
        }
        const url = URL.createObjectURL(
          new Blob([result.contents], { type: result.mimeType }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        toast.success(t("view.exportedTo", { filename: result.filename }));
      } catch (err) {
        toast.error(formatAgentError(err, t("view.exportFailed")));
      }
    },
    [t],
  );

  const handleConfirmImageImport = useCallback(
    async (request: Parameters<typeof createPersona>[0]) => {
      try {
        // The configuration dialog owns provider/model validation and only
        // submits the reviewed selection. Do not independently reinterpret it
        // here or the persisted request can drift from what the user saw.
        const created = await createPersona(request);
        // Completed on confirmed success, after the create resolves.
        trackAgentCreateCompleted({
          provider: created.provider,
          model: created.model,
        });
        setImageImport(null);
        setActivePersona(created.id);
        toast.success(t("imageImport.added"));
      } catch (error) {
        toast.error(formatAgentError(error, t("editor.saveFailed")));
        throw error;
      }
    },
    [createPersona, setActivePersona, t],
  );

  const handleImportError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  const validateImportFile = useCallback(
    (file: Pick<File, "name" | "type" | "size">) => {
      if (isAgentZipFileName(file.name)) {
        if (file.size > MAX_SNAPSHOT_PNG_BYTES) {
          return t("view.importTooLarge", { maxSize: "10 MB" });
        }
        return null;
      }
      if (isAgentImageFileName(file.name)) {
        if (file.size > MAX_SNAPSHOT_PNG_BYTES) {
          return t("imageImport.tooLarge");
        }
        if (file.type && file.type !== "image/png") {
          return t("imageImport.pngOnly");
        }
        return null;
      }
      const message = validatePersonaImportFile(file);
      return message ? t(message.key, message.options) : null;
    },
    [t],
  );

  const handleImportContents = useCallback(
    async (fileContents: string, fileName: string) => {
      try {
        const imported = await importPersonas(fileContents, fileName);
        // Completed once per persona the import actually created (a native
        // JSON export can carry several), after the creates resolve.
        for (const persona of imported) {
          trackAgentCreateCompleted({
            provider: persona.provider,
            model: persona.model,
          });
        }
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
    async (
      fileBytes: Uint8Array,
      fileName: string,
      preview?: { snapshot?: ReturnType<typeof decodeAgentImage> },
    ) => {
      try {
        // The import dialog extracts ZIPs before this handler runs, so these
        // bytes are always a directly importable agent file.
        if (isAgentImageFileName(fileName)) {
          setImageImport({
            snapshot: preview?.snapshot ?? decodeAgentImage(fileBytes),
            bytes: fileBytes,
          });
          return;
        }
        await handleImportContents(decodeImportFileBytes(fileBytes), fileName);
      } catch (err) {
        toast.error(formatAgentError(err, t("view.importFailed")));
      }
    },
    [handleImportContents, t],
  );

  const handleGalleryImportFile = useCallback(
    (fileBytes: Uint8Array, fileName: string) => {
      // Gallery drops share the dialog's preparation flow (worker extraction,
      // cancellation, preview, confirmation) instead of importing directly.
      setGalleryImportFile({ bytes: fileBytes, name: fileName });
      setImportDialogOpen(true);
    },
    [],
  );

  // Stable identity: the dialog's initial-file effect aborts and restarts
  // preparation when this callback changes, so it must not change per render.
  const prepareImportFile = useCallback(
    async (bytes: Uint8Array, name: string, signal: AbortSignal) => {
      let extracted: ExtractedAgentFile;
      try {
        extracted = isAgentZipFileName(name)
          ? await extractAgentFileFromZipInWorker(bytes, signal)
          : { bytes, name };
      } catch (error) {
        if (error instanceof AgentZipImportError) {
          throw new Error(formatAgentZipImportError(error, t));
        }
        throw error;
      }
      if (isAgentImageFileName(extracted.name)) {
        const snapshot = decodeAgentImage(extracted.bytes);
        const { width, height } = getPngDimensions(extracted.bytes);
        const preview = {
          displayName:
            snapshot.profile?.displayName ??
            snapshot.definition.name ??
            "Imported agent",
          systemPrompt: snapshot.definition.systemPrompt ?? "",
          identity: extracted.name,
          avatar:
            typeof snapshot.profile?.avatarDataUrl === "string" &&
            isSafePngAvatarDataUrl(snapshot.profile.avatarDataUrl)
              ? snapshot.profile.avatarDataUrl
              : undefined,
          snapshot,
          cardAspectRatio: width / height,
          cardImageUrl: URL.createObjectURL(
            new Blob([new Uint8Array(extracted.bytes).buffer], {
              type: "image/png",
            }),
          ),
        };
        return { ...extracted, preview };
      }
      const preview = previewPersonaImport(
        decodeImportFileBytes(extracted.bytes),
        extracted.name,
      );
      return { ...extracted, preview };
    },
    [t],
  );

  const dialogs = (
    <>
      {importDialogOpen ? (
        <AgentImportDialog
          open
          onOpenChange={(nextOpen) => {
            setImportDialogOpen(nextOpen);
            if (!nextOpen) setGalleryImportFile(null);
          }}
          initialFile={galleryImportFile}
          onImportFile={handleImportFileBytes}
          prepareImport={prepareImportFile}
          validateImportFile={validateImportFile}
          onImportError={handleImportError}
          maxImportBytes={MAX_SNAPSHOT_PNG_BYTES}
          importTooLargeMessage={t("imageImport.tooLarge")}
        />
      ) : null}
      {imageImport ? (
        <AgentImageImportDialog
          key={imageImport.snapshot.definition.name ?? "imported-agent"}
          snapshot={imageImport.snapshot}
          imageBytes={imageImport.bytes}
          onCancel={() => setImageImport(null)}
          onConfirm={handleConfirmImageImport}
        />
      ) : null}
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
              className={buttonVariants({
                variant: "primary",
                destructive: true,
              })}
              onClick={handleConfirmDeletePersona}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {sharingPersona ? (
        <AgentShareDialog
          open
          persona={sharingPersona}
          onOpenChange={(open) => !open && setSharingPersonaId(null)}
          onDownloadAgent={handleExportPersona}
        />
      ) : null}
    </>
  );

  if (activePersona) {
    return (
      <>
        <AgentDetailPage
          persona={activePersona}
          onBack={() => setActivePersona(null)}
          onStartChat={handleStartChat}
          onEdit={handleEditPersona}
          onDuplicate={handleDuplicatePersona}
          onDelete={handleDeletePersona}
          onExport={handleExportPersona}
          onShare={handleSharePersona}
          onAvatarUpdate={handleUpdateAvatar}
        />
        {dialogs}
      </>
    );
  }

  return (
    <PageShell
      contentWidth="full"
      contentAlign={isVerticallyCentered ? "center" : "top"}
      contentClassName="agents-gallery-transition-surface pb-40"
      showTopFade
      showBottomFade={false}
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
          draftSessions={agentDraftSessions}
          onSelectPersona={handleSelectPersona}
          onStartChatPersona={handleStartChat}
          onEditPersona={handleEditPersona}
          onDuplicatePersona={handleDuplicatePersona}
          onDeletePersona={handleDeletePersona}
          onExportPersona={handleExportPersona}
          onSharePersona={handleSharePersona}
          onCreatePersona={handleCreatePersona}
          onImportAgentImage={() => setImportDialogOpen(true)}
          onContinueDraft={handleContinueDraft}
          onDeleteDraft={handleDeleteDraft}
          onImportFile={handleGalleryImportFile}
          validateImportFile={validateImportFile}
          onImportError={handleImportError}
          maxImportBytes={MAX_SNAPSHOT_PNG_BYTES}
          importTooLargeMessage={t("imageImport.tooLarge")}
          isLoading={personasLoading}
        />
      </motion.section>

      {dialogs}
    </PageShell>
  );
}
