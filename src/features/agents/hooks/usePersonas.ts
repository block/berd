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
  const setPersonas = useAgentStore((s) => s.setPersonas);
  const addPersona = useAgentStore((s) => s.addPersona);
  const updatePersonaInStore = useAgentStore((s) => s.updatePersona);
  const removePersona = useAgentStore((s) => s.removePersona);
  const setPersonasLoading = useAgentStore((s) => s.setPersonasLoading);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listRequestInFlightRef = useRef(false);
  const mutationVersionRef = useRef(0);
  const mutationsInFlightRef = useRef(0);

  const replacePersonasFromApi = useCallback(
    async (
      fetchPersonas: () => Promise<Persona[]>,
      options: { showLoading: boolean; errorMessage: string },
    ) => {
      if (listRequestInFlightRef.current) {
        return;
      }

      listRequestInFlightRef.current = true;
      const mutationVersionAtStart = mutationVersionRef.current;
      if (options.showLoading) {
        setPersonasLoading(true);
      }

      try {
        const personas = await fetchPersonas();
        if (
          mutationVersionAtStart === mutationVersionRef.current &&
          mutationsInFlightRef.current === 0
        ) {
          setPersonas(personas);
        }
      } catch (error) {
        console.error(options.errorMessage, error);
      } finally {
        listRequestInFlightRef.current = false;
        if (options.showLoading) {
          setPersonasLoading(false);
        }
      }
    },
    [setPersonas, setPersonasLoading],
  );

  const trackMutation = useCallback(async <T>(mutation: () => Promise<T>) => {
    mutationVersionRef.current += 1;
    mutationsInFlightRef.current += 1;
    try {
      return await mutation();
    } finally {
      mutationsInFlightRef.current -= 1;
      mutationVersionRef.current += 1;
    }
  }, []);

  const loadPersonas = useCallback(async () => {
    await replacePersonasFromApi(api.listPersonas, {
      showLoading: true,
      errorMessage: "Failed to load personas:",
    });
  }, [replacePersonasFromApi]);

  const refreshFromDisk = useCallback(async () => {
    await replacePersonasFromApi(api.refreshPersonas, {
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
      const persona = await trackMutation(() => api.createPersona(req));
      addPersona(persona);
      return persona;
    },
    [addPersona, trackMutation],
  );

  // Custom gloopies are library citizens, not per-agent attachments: a
  // displaced or orphaned `user-avatar:<id>` stays in the Gloopies collection
  // so any agent can wear it again. Library-level delete is a deliberate later
  // feature (alongside export), so no reference-count garbage collection
  // happens here.
  const updatePersona = useCallback(
    async (existing: Persona, req: UpdatePersonaRequest) => {
      const persona = await trackMutation(() =>
        api.updatePersona(existing, req),
      );
      updatePersonaInStore(existing.id, persona);
      return persona;
    },
    [trackMutation, updatePersonaInStore],
  );

  const deletePersona = useCallback(
    async (id: string) => {
      await trackMutation(() => api.deletePersona(id));
      removePersona(id);
    },
    [removePersona, trackMutation],
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
