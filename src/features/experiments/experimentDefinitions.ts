export type ExperimentConfigValue = boolean | number | string;

export type ExperimentConfigControl =
  | {
      type: "boolean";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: boolean;
    }
  | {
      type: "select";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: string;
      options: readonly {
        labelKey: string;
        value: string;
      }[];
    }
  | {
      type: "number";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      type: "text";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: string;
      placeholderKey?: string;
      multiline?: boolean;
    };

export interface ExperimentDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  /** Default state for users without an explicit per-experiment override. */
  defaultEnabled?: boolean;
  config?: Record<string, ExperimentConfigControl>;
}

export const BUILDERBOT_SURFACE_EXPERIMENT_ID = "builderbot-surface";

export const VOICE_CONVERSATION_EXPERIMENT_ID = "voice-conversation";

export const TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID =
  "transcript-virtual-renderer";

export const GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID = "gloopie-avatar-creator";

export const STARTER_TASKS_EXPERIMENT_ID = "onboarding-starter-tasks";

export const BERDY_ONBOARDING_EXPERIMENT_ID = "berdy-onboarding";

export const SKILL_DISCOVERY_EXPERIMENT_ID = "skill-discovery";

export const EXPERIMENT_DEFINITIONS = [
  {
    id: BUILDERBOT_SURFACE_EXPERIMENT_ID,
    titleKey: "experiments.builderbot.title",
    descriptionKey: "experiments.builderbot.description",
  },
  {
    id: TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
    titleKey: "experiments.transcriptVirtualRenderer.title",
    descriptionKey: "experiments.transcriptVirtualRenderer.description",
    defaultEnabled: true,
  },
  {
    id: SKILL_DISCOVERY_EXPERIMENT_ID,
    titleKey: "experiments.skillDiscovery.title",
    descriptionKey: "experiments.skillDiscovery.description",
    // Skill discovery is an opt-in surface because it requires the optional
    // sq-agents CLI and can make remote catalog requests.
    defaultEnabled: false,
  },
  {
    id: STARTER_TASKS_EXPERIMENT_ID,
    titleKey: "experiments.starterTasks.title",
    descriptionKey: "experiments.starterTasks.description",
  },
  {
    id: GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID,
    titleKey: "experiments.gloopieAvatarCreator.title",
    descriptionKey: "experiments.gloopieAvatarCreator.description",
  },
  {
    id: VOICE_CONVERSATION_EXPERIMENT_ID,
    titleKey: "experiments.voiceConversation.title",
    descriptionKey: "experiments.voiceConversation.description",
    defaultEnabled: true,
  },
  {
    id: BERDY_ONBOARDING_EXPERIMENT_ID,
    titleKey: "experiments.berdyOnboarding.title",
    descriptionKey: "experiments.berdyOnboarding.description",
  },
] as const satisfies readonly ExperimentDefinition[];
