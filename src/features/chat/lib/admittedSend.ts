import type { ChatAttachmentDraft } from "@/shared/types/messages";
import type { ChatSendOptions } from "../types";

export type PersonaIntent =
  | { kind: "inherit" }
  | { kind: "none" }
  | { kind: "persona"; id: string; name?: string };

export interface QueuedMessagePayload {
  text: string;
  persona: PersonaIntent;
  attachments?: ChatAttachmentDraft[];
  sendOptions?: ChatSendOptions;
  showInComposer?: boolean;
}

export type AdmittedQueuedMessagePayload = QueuedMessagePayload;

export function isAdmittedQueuedMessagePayload(
  _payload: QueuedMessagePayload,
): _payload is AdmittedQueuedMessagePayload {
  return true;
}

export function personaIntentFromComposer(
  personaId: string | null | undefined,
  personaName?: string,
): PersonaIntent {
  if (personaId === undefined) return { kind: "inherit" };
  if (personaId === null) return { kind: "none" };
  return {
    kind: "persona",
    id: personaId,
    ...(personaName ? { name: personaName } : {}),
  };
}

export function personaIntentToOverride(
  persona: PersonaIntent,
): { id: string | null; name?: string } | undefined {
  if (persona.kind === "inherit") return undefined;
  if (persona.kind === "none") return { id: null };
  return { id: persona.id, ...(persona.name ? { name: persona.name } : {}) };
}

export function createDeferredQueuedMessagePayload(
  payload: QueuedMessagePayload,
): QueuedMessagePayload {
  return payload;
}

export function admitComposerQueuedMessage(
  payload: Omit<QueuedMessagePayload, "persona"> & {
    personaId: string | null | undefined;
    personaName?: string;
  },
): AdmittedQueuedMessagePayload {
  const { personaId, personaName, ...rest } = payload;
  return {
    ...rest,
    persona: personaIntentFromComposer(personaId, personaName),
  };
}

export function admitSystemInheritedQueuedMessage(
  payload: Omit<QueuedMessagePayload, "persona">,
): AdmittedQueuedMessagePayload {
  return { ...payload, persona: { kind: "inherit" } };
}
