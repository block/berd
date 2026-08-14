import {
  selectStarterAgentPersonas,
  starterAgentIndex,
} from "@/features/home/onboarding/starterAgents";
import {
  getStarterTasksHeight,
  STARTER_HOME_LAYOUT,
} from "@/features/home/onboarding/starterHomeLayout";
import {
  STARTER_PROJECT_ID,
  STARTER_TASKS_NOTE_ID,
} from "@/features/home/onboarding/starterTasks";
import {
  createDefaultHomeLayoutItems,
  layoutItemsToHomeWidgets,
} from "@/features/home/lib/homeLayoutMapper";
import type { WidgetInstance } from "@/features/home/widgets/types";
import type { Persona } from "@/shared/types/agents";

/** Builds the complete, canonical first-run/reset Home composition. */
export function createStarterHomeWidgets(
  personas: readonly Persona[],
): WidgetInstance[] {
  const starterPersonas = selectStarterAgentPersonas(personas);

  const defaultWidgets = layoutItemsToHomeWidgets(
    createDefaultHomeLayoutItems(undefined, true),
  );
  const starterClock = defaultWidgets.find(
    (instance) => instance.type === "clock",
  );
  const berdyTour = defaultWidgets.find(
    (instance) => instance.type === "onboardingTour",
  );
  if (!starterClock || !berdyTour) return [];

  const arrangedBase = defaultWidgets.map((instance) => {
    if (instance.id === starterClock.id) {
      return { ...instance, ...STARTER_HOME_LAYOUT.clock };
    }
    if (instance.id === berdyTour.id) {
      return { ...instance, ...STARTER_HOME_LAYOUT.berdy };
    }
    return instance;
  });
  let nextZ = arrangedBase.reduce(
    (max, instance) => Math.max(max, instance.z),
    0,
  );
  const starterWidgets: WidgetInstance[] = [
    ...arrangedBase,
    {
      id: crypto.randomUUID(),
      type: "onboardingProjectArtifact",
      ...STARTER_HOME_LAYOUT.project,
      z: ++nextZ,
      state: {
        projectId: STARTER_PROJECT_ID,
        onboardingStarterProject: true,
      },
    },
    {
      id: crypto.randomUUID(),
      type: "stickyNote",
      ...STARTER_HOME_LAYOUT.tasks,
      height: getStarterTasksHeight(0),
      z: ++nextZ,
      state: { noteId: STARTER_TASKS_NOTE_ID },
    },
    ...starterPersonas.map((persona) => ({
      id: crypto.randomUUID(),
      type: "agentPin" as const,
      ...STARTER_HOME_LAYOUT.agents[starterAgentIndex(persona)],
      z: ++nextZ,
      state: { agentId: persona.id },
    })),
  ];

  return starterWidgets.map((instance) =>
    instance.id === berdyTour.id ? { ...instance, z: nextZ + 1 } : instance,
  );
}
