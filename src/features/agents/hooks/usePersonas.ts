import { useEffect, useCallback, useRef } from "react";
import { useAgentStore } from "../stores/agentStore";
import {
  selectPersonas,
  selectPersonasLoading,
} from "../stores/agentSelectors";
import type {
  CreatePersonaRequest,
  UpdatePersonaRequest,
  Persona,
} from "@/shared/types/agents";
import * as api from "@/shared/api/agents";

const REFRESH_INTERVAL_MS = 60_000;

export function usePersonas() {
  const personas = useAgentStore(selectPersonas);
  const personasLoading = useAgentStore(selectPersonasLoading);
  const refreshGallery = useAgentStore((s) => s.refreshGallery);
  const mutateGallery = useAgentStore((s) => s.mutateGallery);
  const addPersona = useAgentStore((s) => s.addPersona);
  const updatePersonaInStore = useAgentStore((s) => s.updatePersona);
  const removePersona = useAgentStore((s) => s.removePersona);
  const setPersonasLoading = useAgentStore((s) => s.setPersonasLoading);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listRequestInFlightRef = useRef(false);

  const replacePersonasFromApi = useCallback(
    async (
      fetchGallery: () => Promise<api.AgentGalleryListing>,
      options: { showLoading: boolean; errorMessage: string },
    ) => {
      if (listRequestInFlightRef.current) {
        return;
      }

      listRequestInFlightRef.current = true;
      if (options.showLoading) {
        setPersonasLoading(true);
      }

      try {
        await refreshGallery(fetchGallery);
      } catch (error) {
        console.error(options.errorMessage, error);
      } finally {
        listRequestInFlightRef.current = false;
        if (options.showLoading) {
          setPersonasLoading(false);
        }
      }
    },
    [refreshGallery, setPersonasLoading],
  );

  const loadPersonas = useCallback(async () => {
    await replacePersonasFromApi(api.listAgentGallery, {
      showLoading: true,
      errorMessage: "Failed to load personas:",
    });
  }, [replacePersonasFromApi]);

  const refreshFromDisk = useCallback(async () => {
    await replacePersonasFromApi(api.refreshAgentGallery, {
      showLoading: false,
      errorMessage: "Failed to refresh personas from disk:",
    });
  }, [replacePersonasFromApi]);

  useEffect(() => {
    loadPersonas();
  }, [loadPersonas]);

  // Periodic refresh every 60s and on window focus
  useEffect(() => {
    refreshTimerRef.current = setInterval(refreshFromDisk, REFRESH_INTERVAL_MS);

    const handleFocus = () => {
      refreshFromDisk();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshFromDisk]);

  const createPersona = useCallback(
    async (req: CreatePersonaRequest) => {
      const persona = await mutateGallery(() => api.createPersona(req));
      addPersona(persona);
      return persona;
    },
    [addPersona, mutateGallery],
  );

  // Custom gloopies are library citizens, not per-agent attachments: a
  // displaced or orphaned `user-avatar:<id>` stays in the Gloopies collection
  // so any agent can wear it again. Library-level delete is a deliberate later
  // feature (alongside export), so no reference-count garbage collection
  // happens here.
  const updatePersona = useCallback(
    async (existing: Persona, req: UpdatePersonaRequest) => {
      const persona = await mutateGallery(() =>
        api.updatePersona(existing, req),
      );
      updatePersonaInStore(existing.id, persona);
      return persona;
    },
    [mutateGallery, updatePersonaInStore],
  );

  const deletePersona = useCallback(
    async (id: string) => {
      await mutateGallery(() => api.deletePersona(id));
      removePersona(id);
    },
    [mutateGallery, removePersona],
  );

  return {
    personas,
    isLoading: personasLoading,
    createPersona,
    updatePersona,
    deletePersona,
    refresh: loadPersonas,
    refreshFromDisk,
  };
}
