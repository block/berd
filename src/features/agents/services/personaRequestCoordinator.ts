import { useAgentStore } from "@/features/agents/stores/agentStore";
import * as api from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";

type PersonaReader = () => Promise<Persona[]>;

let activeDrain: Promise<void> | null = null;
let invalidationEpoch = 0;
let mutationsInFlight = 0;
let trailingReadRequired = false;
let dirtyAfterMutation = false;
let applyingAuthoritativeSnapshot = false;
let unsubscribeFromPersonaStore: (() => void) | null = null;

function ensureCoordinatorInitialized(): void {
  if (unsubscribeFromPersonaStore) return;
  let previousPersonas = useAgentStore.getState().personas;
  unsubscribeFromPersonaStore = useAgentStore.subscribe((state) => {
    if (state.personas === previousPersonas) return;
    previousPersonas = state.personas;
    if (applyingAuthoritativeSnapshot) return;
    invalidationEpoch += 1;
    if (activeDrain) trailingReadRequired = true;
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

function scheduleReconciliation(): void {
  if (!dirtyAfterMutation || mutationsInFlight > 0 || activeDrain) return;
  void refreshPersonasCoordinated();
}

async function drainReads(
  initialReader: PersonaReader,
  showLoading: boolean,
  errorMessage: string,
): Promise<void> {
  if (showLoading) useAgentStore.getState().setPersonasLoading(true);
  let reader = initialReader;
  try {
    while (true) {
      trailingReadRequired = false;
      const epochAtStart = invalidationEpoch;
      try {
        const personas = await reader();
        const snapshotIsCurrent = epochAtStart === invalidationEpoch;
        if (snapshotIsCurrent) {
          dirtyAfterMutation = false;
          commitAuthoritativeSnapshot(personas);
        } else if (mutationsInFlight > 0) {
          dirtyAfterMutation = true;
          return;
        } else {
          trailingReadRequired = true;
        }
      } catch (error) {
        console.error(errorMessage, error);
        if (!trailingReadRequired) return;
      }

      if (!trailingReadRequired) return;
      reader = api.refreshPersonas;
    }
  } finally {
    if (showLoading) useAgentStore.getState().setPersonasLoading(false);
  }
}

function requestRead(
  reader: PersonaReader,
  options: {
    showLoading: boolean;
    errorMessage: string;
    requireFreshSnapshot: boolean;
  },
): Promise<void> {
  ensureCoordinatorInitialized();
  if (activeDrain) {
    if (options.requireFreshSnapshot) {
      invalidationEpoch += 1;
      trailingReadRequired = true;
    }
    return activeDrain;
  }

  activeDrain = drainReads(
    reader,
    options.showLoading,
    options.errorMessage,
  ).finally(() => {
    activeDrain = null;
    scheduleReconciliation();
  });
  return activeDrain;
}

export function loadPersonasCoordinated(): Promise<void> {
  return requestRead(api.listPersonas, {
    showLoading: true,
    errorMessage: "Failed to load personas:",
    requireFreshSnapshot: false,
  });
}

export function refreshPersonasCoordinated(): Promise<void> {
  return requestRead(api.refreshPersonas, {
    showLoading: false,
    errorMessage: "Failed to refresh personas from disk:",
    requireFreshSnapshot: true,
  });
}

export async function runPersonaMutation<T>(
  mutation: () => Promise<T>,
): Promise<T> {
  ensureCoordinatorInitialized();
  invalidationEpoch += 1;
  mutationsInFlight += 1;
  if (activeDrain) trailingReadRequired = true;
  try {
    return await mutation();
  } finally {
    mutationsInFlight -= 1;
    dirtyAfterMutation = true;
    scheduleReconciliation();
  }
}

export function resetPersonaRequestCoordinatorForTests(): void {
  unsubscribeFromPersonaStore?.();
  unsubscribeFromPersonaStore = null;
  activeDrain = null;
  invalidationEpoch = 0;
  mutationsInFlight = 0;
  trailingReadRequired = false;
  dirtyAfterMutation = false;
  applyingAuthoritativeSnapshot = false;
}
