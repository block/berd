import { useAgentStore } from "@/features/agents/stores/agentStore";
import * as api from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";

type PersonaReader = () => Promise<Persona[]>;
type ReadKind = "load" | "refresh";

type ActiveRead = {
  generation: number;
  kind: ReadKind;
  promise: Promise<void>;
};

const PERSONA_READ_TIMEOUT_MS = 5_000;
const READ_TIMEOUT = Symbol("persona-read-timeout");

let activeRead: ActiveRead | null = null;
let generation = 0;
let applyingAuthoritativeSnapshot = false;
let unsubscribeFromPersonaStore: (() => void) | null = null;
let reconciliationScheduled = false;

function scheduleExternalWriteReconciliation(): void {
  if (reconciliationScheduled) return;
  reconciliationScheduled = true;
  queueMicrotask(() => {
    reconciliationScheduled = false;
    void refreshPersonasCoordinated();
  });
}

function ensureCoordinatorInitialized(): void {
  if (unsubscribeFromPersonaStore) return;
  let previousPersonas = useAgentStore.getState().personas;
  unsubscribeFromPersonaStore = useAgentStore.subscribe((state) => {
    if (state.personas === previousPersonas) return;
    previousPersonas = state.personas;
    if (applyingAuthoritativeSnapshot) return;
    generation += 1;
    scheduleExternalWriteReconciliation();
  });
}

function commitAuthoritativeSnapshot(personas: Persona[]): void {
  applyingAuthoritativeSnapshot = true;
  try {
    useAgentStore.getState().setPersonas(personas);
  } finally {
    applyingAuthoritativeSnapshot = false;
  }
}

async function readWithTimeout(
  reader: PersonaReader,
): Promise<Persona[] | typeof READ_TIMEOUT> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader(),
      new Promise<typeof READ_TIMEOUT>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(READ_TIMEOUT),
          PERSONA_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function startRead(
  kind: ReadKind,
  reader: PersonaReader,
  showLoading: boolean,
  errorMessage: string,
): Promise<void> {
  ensureCoordinatorInitialized();
  const readGeneration = ++generation;
  if (showLoading) useAgentStore.getState().setPersonasLoading(true);

  let promise!: Promise<void>;
  promise = (async () => {
    try {
      const result = await readWithTimeout(reader);
      if (result === READ_TIMEOUT) {
        console.warn(`${errorMessage} request timed out`);
        return;
      }
      if (readGeneration === generation) commitAuthoritativeSnapshot(result);
    } catch (error) {
      console.error(errorMessage, error);
    } finally {
      if (showLoading) {
        useAgentStore.getState().setPersonasLoading(false);
      }
      if (activeRead?.promise === promise) activeRead = null;
    }
  })();
  activeRead = { generation: readGeneration, kind, promise };
  return promise;
}

export function loadPersonasCoordinated(): Promise<void> {
  ensureCoordinatorInitialized();
  if (activeRead?.kind === "load") return activeRead.promise;
  return startRead("load", api.listPersonas, true, "Failed to load personas:");
}

export function refreshPersonasCoordinated(): Promise<void> {
  ensureCoordinatorInitialized();
  if (activeRead?.kind === "refresh") return activeRead.promise;
  if (activeRead?.kind === "load") {
    useAgentStore.getState().setPersonasLoading(false);
  }
  return startRead(
    "refresh",
    api.refreshPersonas,
    false,
    "Failed to refresh personas from disk:",
  );
}

export async function runPersonaMutation<T>(
  mutation: () => Promise<T>,
): Promise<T> {
  ensureCoordinatorInitialized();
  generation += 1;
  try {
    return await mutation();
  } finally {
    scheduleExternalWriteReconciliation();
  }
}

export function resetPersonaRequestCoordinatorForTests(): void {
  unsubscribeFromPersonaStore?.();
  unsubscribeFromPersonaStore = null;
  activeRead = null;
  generation = 0;
  applyingAuthoritativeSnapshot = false;
  reconciliationScheduled = false;
}
