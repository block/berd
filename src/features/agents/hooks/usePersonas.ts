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
import {
  loadPersonasCoordinated,
  refreshPersonasCoordinated,
  runPersonaMutation,
} from "@/features/agents/services/personaRequestCoordinator";
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
  const addPersona = useAgentStore((s) => s.addPersona);
  const updatePersonaInStore = useAgentStore((s) => s.updatePersona);
  const removePersona = useAgentStore((s) => s.removePersona);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPersonas = useCallback(loadPersonasCoordinated, []);
  const refreshFromDisk = useCallback(refreshPersonasCoordinated, []);

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
    async (req: CreatePersonaRequest) =>
      runPersonaMutation(async () => {
        const persona = await api.createPersona(req);
        addPersona(persona);
        return persona;
      }),
    [addPersona],
  );

  const updatePersona = useCallback(
    async (existing: Persona, req: UpdatePersonaRequest) =>
      runPersonaMutation(async () => {
        const persona = await api.updatePersona(existing, req);
        const displacedAvatar = useAgentStore
          .getState()
          .personas.find((candidate) => candidate.id === existing.id)?.avatar;
        updatePersonaInStore(existing.id, persona);
        if (displacedAvatar !== persona.avatar) {
          deleteUnreferencedUserAvatar(displacedAvatar);
        }
        return persona;
      }),
    [updatePersonaInStore],
  );

  const deletePersona = useCallback(
    async (id: string) =>
      runPersonaMutation(async () => {
        const deletedAvatar = useAgentStore
          .getState()
          .personas.find((persona) => persona.id === id)?.avatar;
        await api.deletePersona(id);
        removePersona(id);
        deleteUnreferencedUserAvatar(deletedAvatar);
      }),
    [removePersona],
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
