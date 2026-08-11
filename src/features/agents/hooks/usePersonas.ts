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
import { deleteUserAvatar } from "@/shared/api/avatars";
import { isUserAvatarRef } from "@/shared/avatars/catalog";

const REFRESH_INTERVAL_MS = 60_000;

function deleteUnreferencedUserAvatar(avatar: string | null | undefined) {
  if (!avatar || !isUserAvatarRef(avatar)) return;
  const stillReferenced = useAgentStore
    .getState()
    .personas.some((persona) => persona.avatar === avatar);
  if (!stillReferenced) {
    void deleteUserAvatar(avatar).catch((error) => {
      console.warn("Failed to clean up unreferenced agent avatar:", error);
    });
  }
}

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

  const updatePersona = useCallback(
    async (existing: Persona, req: UpdatePersonaRequest) => {
      const persona = await trackMutation(() =>
        api.updatePersona(existing, req),
      );
      const displacedAvatar = useAgentStore
        .getState()
        .personas.find((candidate) => candidate.id === existing.id)?.avatar;
      updatePersonaInStore(existing.id, persona);
      if (displacedAvatar !== persona.avatar) {
        deleteUnreferencedUserAvatar(displacedAvatar);
      }
      return persona;
    },
    [trackMutation, updatePersonaInStore],
  );

  const deletePersona = useCallback(
    async (id: string) => {
      const deletedAvatar = useAgentStore
        .getState()
        .personas.find((persona) => persona.id === id)?.avatar;
      await trackMutation(() => api.deletePersona(id));
      removePersona(id);
      deleteUnreferencedUserAvatar(deletedAvatar);
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
