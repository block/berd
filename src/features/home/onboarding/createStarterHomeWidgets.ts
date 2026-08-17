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
  createDefaultClockWidget,
  createDefaultOnboardingTourWidget,
} from "@/features/home/lib/homeLayoutMapper";
import type { WidgetInstance } from "@/features/home/widgets/types";
import type { Persona } from "@/shared/types/agents";

/** Builds the complete, canonical first-run/reset Home composition. */
export function createStarterHomeWidgets(
  personas: readonly Persona[],
): WidgetInstance[] {
  const starterPersonas = selectStarterAgentPersonas(personas);

  const starterClock = {
    ...createDefaultClockWidget(),
    ...STARTER_HOME_LAYOUT.clock,
  };
  const berdyTour = {
    ...createDefaultOnboardingTourWidget(starterClock),
    ...STARTER_HOME_LAYOUT.berdy,
  };
  const arrangedBase = [starterClock, berdyTour];
  let nextZ = 2;
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
