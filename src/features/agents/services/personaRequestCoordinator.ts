import { useAgentStore } from "@/features/agents/stores/agentStore";
import * as api from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";

type PersonaReader = () => Promise<Persona[]>;

let activeDrain: Promise<void> | null = null;
let invalidationEpoch = 0;
let mutationsInFlight = 0;
let trailingReadRequired = false;
let mutationSettledWaiters: Array<() => void> = [];

function waitForMutationsToSettle(): Promise<void> {
  if (mutationsInFlight === 0) return Promise.resolve();
  return new Promise((resolve) => mutationSettledWaiters.push(resolve));
}

function notifyMutationsSettled(): void {
  const waiters = mutationSettledWaiters;
  mutationSettledWaiters = [];
  for (const resolve of waiters) resolve();
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
        if (epochAtStart === invalidationEpoch && mutationsInFlight === 0) {
          useAgentStore.getState().setPersonas(personas);
        } else {
          trailingReadRequired = true;
        }
      } catch (error) {
        console.error(errorMessage, error);
        return;
      }

      if (!trailingReadRequired) return;
      await waitForMutationsToSettle();
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
  invalidationEpoch += 1;
  mutationsInFlight += 1;
  if (activeDrain) trailingReadRequired = true;
  try {
    return await mutation();
  } finally {
    mutationsInFlight -= 1;
    invalidationEpoch += 1;
    if (mutationsInFlight === 0) notifyMutationsSettled();
  }
}

export function resetPersonaRequestCoordinatorForTests(): void {
  activeDrain = null;
  invalidationEpoch = 0;
  mutationsInFlight = 0;
  trailingReadRequired = false;
  mutationSettledWaiters = [];
}
