export const ONBOARDING_STEPS = [
  "welcome",
  "work-types",
  "recommendations",
  "harness",
  "harness-setup",
  "complete",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingLifecycle = "not-started" | "in-progress" | "completed";

export interface OnboardingState {
  lifecycle: OnboardingLifecycle;
  step: OnboardingStep;
  selectedWorkTypeIds: string[];
  selectedAgentId: string | null;
  selectedHarnessId: string | null;
  completedHarnessSetupIds: string[];
  // null means the welcome consent ceremony has never been completed; the
  // answer is recorded when the user advances past the landing page, not per
  // checkbox toggle, so declining is still just leaving the page.
  shareUsageData: boolean | null;
}

export const INITIAL_ONBOARDING_STATE: Readonly<OnboardingState> = {
  lifecycle: "not-started",
  step: ONBOARDING_STEPS[0],
  selectedWorkTypeIds: [],
  selectedAgentId: null,
  selectedHarnessId: null,
  completedHarnessSetupIds: [],
  shareUsageData: null,
};

export type OnboardingAction =
  | { type: "start" }
  | { type: "next" }
  | { type: "back" }
  | { type: "go-to"; step: OnboardingStep }
  | { type: "toggle-work-type"; workTypeId: string }
  | { type: "set-work-types"; workTypeIds: string[] }
  | { type: "select-agent"; agentId: string | null }
  | { type: "select-harness"; harnessId: string | null }
  | { type: "complete-harness-setup"; harnessId: string }
  | { type: "set-share-usage-data"; shareUsageData: boolean }
  | { type: "complete" }
  | { type: "replay" }
  | { type: "reset" };

function stepAtOffset(step: OnboardingStep, offset: number): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  const nextIndex = Math.max(
    0,
    Math.min(ONBOARDING_STEPS.length - 1, index + offset),
  );
  return ONBOARDING_STEPS[nextIndex];
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case "start":
      return state.lifecycle === "not-started"
        ? { ...state, lifecycle: "in-progress" }
        : state;
    case "next": {
      const step = stepAtOffset(state.step, 1);
      return {
        ...state,
        lifecycle: step === "complete" ? "completed" : "in-progress",
        step,
      };
    }
    case "back":
      return {
        ...state,
        lifecycle: "in-progress",
        step: stepAtOffset(state.step, -1),
      };
    case "go-to":
      return {
        ...state,
        lifecycle: action.step === "complete" ? "completed" : "in-progress",
        step: action.step,
      };
    case "toggle-work-type": {
      const selected = state.selectedWorkTypeIds.includes(action.workTypeId);
      return {
        ...state,
        selectedWorkTypeIds: selected
          ? state.selectedWorkTypeIds.filter((id) => id !== action.workTypeId)
          : [...state.selectedWorkTypeIds, action.workTypeId],
      };
    }
    case "set-work-types":
      return { ...state, selectedWorkTypeIds: uniqueIds(action.workTypeIds) };
    case "select-agent":
      return { ...state, selectedAgentId: action.agentId };
    case "select-harness":
      return { ...state, selectedHarnessId: action.harnessId };
    case "complete-harness-setup":
      return {
        ...state,
        completedHarnessSetupIds: uniqueIds([
          ...state.completedHarnessSetupIds,
          action.harnessId,
        ]),
      };
    case "set-share-usage-data":
      return { ...state, shareUsageData: action.shareUsageData };
    case "complete":
      return { ...state, lifecycle: "completed", step: "complete" };
    case "replay":
      return {
        ...INITIAL_ONBOARDING_STATE,
        lifecycle: "in-progress",
        step: "welcome",
        // Replay resets the presentation, not durable product outcomes. A
        // provider configured during onboarding remains configured, and a
        // consent answer already given stays answered.
        completedHarnessSetupIds: state.completedHarnessSetupIds,
        shareUsageData: state.shareUsageData,
      };
    case "reset":
      return { ...INITIAL_ONBOARDING_STATE };
  }
}
