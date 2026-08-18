import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas } from "@/shared/api/agents";
import {
  markStarterAgentPinsEligible,
  markStarterAgentPinsSeeded,
  resetStarterAgentPinsSeeded,
  selectStarterAgentPersonas,
} from "@/features/home/onboarding/starterAgents";
import { STARTER_HOME_LAYOUT } from "@/features/home/onboarding/starterHomeLayout";
import {
  useHomeWidgetStore,
  type OnboardingHomeResetResult,
} from "@/features/home/stores/homeWidgetStore";

async function initializeHomeWidgets(): Promise<void> {
  const state = useHomeWidgetStore.getState();
  if (state.loadStatus !== "ready") {
    await state.initialize();
  }
}

export async function syncOnboardingExperimentState(
  enabled: boolean,
): Promise<void> {
  await initializeHomeWidgets();
  useHomeWidgetStore.getState().syncOnboardingExperiment(enabled);
}

export async function resetStarterTasksExperience(): Promise<boolean> {
  await initializeHomeWidgets();
  return useHomeWidgetStore.getState().resetStarterTasks();
}

async function restoreStarterAgentPins(): Promise<boolean> {
  let starterPersonas: ReturnType<typeof selectStarterAgentPersonas>;
  try {
    const personas = await listPersonas();
    starterPersonas = selectStarterAgentPersonas(personas);
    // Merge by stable identity so newly allocated starter personas resolve
    // immediately without replacing concurrent persona edits in the store.
    const currentPersonas = useAgentStore.getState().personas;
    const refreshedById = new Map(
      personas.map((persona) => [persona.id, persona]),
    );
    useAgentStore
      .getState()
      .setPersonas([
        ...currentPersonas.map(
          (persona) => refreshedById.get(persona.id) ?? persona,
        ),
        ...personas.filter(
          (persona) =>
            !currentPersonas.some((current) => current.id === persona.id),
        ),
      ]);
  } catch (error) {
    console.error(
      "Failed to load starter agents during onboarding reset:",
      error,
    );
    markStarterAgentPinsEligible();
    return false;
  }

  if (starterPersonas.length !== STARTER_HOME_LAYOUT.agents.length) {
    markStarterAgentPinsEligible();
    return false;
  }

  try {
    const didPersist = await useHomeWidgetStore
      .getState()
      .addMissingStarterAgentPins(starterPersonas.map(({ id }) => id));
    if (didPersist) {
      markStarterAgentPinsSeeded();
      return true;
    }
  } catch (error) {
    console.error(
      "Failed to persist starter agents during onboarding reset:",
      error,
    );
  }
  markStarterAgentPinsEligible();
  return false;
}

export async function resetHomeForOnboardingExperience(): Promise<OnboardingHomeResetResult> {
  await initializeHomeWidgets();
  const result = await useHomeWidgetStore.getState().resetHomeForOnboarding();
  if (!result.itemsConfirmed) return result;

  resetStarterAgentPinsSeeded();
  return {
    ...result,
    starterAgentsConfirmed: await restoreStarterAgentPins(),
  };
}

export async function resetOnboardingTourExperience(): Promise<boolean> {
  await initializeHomeWidgets();
  return useHomeWidgetStore.getState().resetOnboardingTour();
}
