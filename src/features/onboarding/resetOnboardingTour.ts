import {
  markStarterAgentPinsEligible,
  markStarterAgentPinsSeeded,
  resetStarterAgentPinsSeeded,
} from "@/features/home/onboarding/starterAgents";
import {
  markStarterHomeArranged,
  STARTER_HOME_LAYOUT,
} from "@/features/home/onboarding/starterHomeLayout";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";

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

export async function resetHomeForOnboardingExperience(): Promise<boolean> {
  resetStarterAgentPinsSeeded();
  await initializeHomeWidgets();
  const didReset = await useHomeWidgetStore.getState().resetHomeForOnboarding();
  if (didReset) {
    const starterAgentPinCount = useHomeWidgetStore
      .getState()
      .instances.filter((instance) => instance.type === "agentPin").length;
    if (starterAgentPinCount === STARTER_HOME_LAYOUT.agents.length) {
      markStarterAgentPinsSeeded();
    } else {
      markStarterAgentPinsEligible();
    }
    markStarterHomeArranged();
  }
  return didReset;
}

export async function resetOnboardingTourExperience(): Promise<boolean> {
  await initializeHomeWidgets();
  return useHomeWidgetStore.getState().resetOnboardingTour();
}
