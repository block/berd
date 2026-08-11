import {
  markStarterAgentPinsEligible,
  resetStarterAgentPinsSeeded,
} from "@/features/home/onboarding/starterAgents";
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
  if (didReset) markStarterAgentPinsEligible();
  return didReset;
}

export async function resetOnboardingTourExperience(): Promise<boolean> {
  await initializeHomeWidgets();
  return useHomeWidgetStore.getState().resetOnboardingTour();
}
