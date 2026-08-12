export const STARTER_TASKS_NOTE_ID = "onboarding:starter-tasks";
export const STARTER_PROJECT_ID = "onboarding-starter-project";

export const STARTER_TASKS = [
  {
    id: "connect-provider",
    labelKey: "onboarding.starterTasks.connectProvider",
  },
  {
    id: "start-chat",
    labelKey: "onboarding.starterTasks.startChat",
  },
  {
    id: "create-project",
    labelKey: "onboarding.starterTasks.createProject",
  },
  {
    id: "add-widget",
    labelKey: "onboarding.starterTasks.addWidget",
  },
] as const;

export type StarterTask = (typeof STARTER_TASKS)[number];
export type StarterTaskId = StarterTask["id"];
export type StarterTaskCompletionState = Record<StarterTaskId, boolean>;

export function omittedStarterTasksAfterFirstRun({
  onboardingCompleted,
  providerHandled,
}: {
  onboardingCompleted: boolean;
  providerHandled: boolean;
}): ReadonlySet<StarterTaskId> {
  return onboardingCompleted && providerHandled
    ? new Set(["connect-provider"])
    : new Set();
}

export function isStarterTaskComplete(
  completionState: StarterTaskCompletionState,
  taskId: StarterTaskId,
): boolean {
  return completionState[taskId];
}
