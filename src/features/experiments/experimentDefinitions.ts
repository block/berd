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
  /** Opt-out of development's global experiment auto-enable behavior. */
  manualEnableOnly?: boolean;
  config?: Record<string, ExperimentConfigControl>;
}

export const BUILDERBOT_SURFACE_EXPERIMENT_ID = "builderbot-surface";

export const VOICE_CONVERSATION_EXPERIMENT_ID = "voice-conversation";

export const TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID =
  "transcript-virtual-renderer";

export const GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID = "gloopie-avatar-creator";

export const AVATAR_COLLECTION_PAGE_EXPERIMENT_ID = "avatar-collection-page";

export const STARTER_TASKS_EXPERIMENT_ID = "onboarding-starter-tasks";

export const BERDY_ONBOARDING_EXPERIMENT_ID = "berdy-onboarding";

export const SKILL_DISCOVERY_EXPERIMENT_ID = "skill-discovery";

export const FIRST_RUN_ONBOARDING_EXPERIMENT_ID = "first-run-onboarding";

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
    id: GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID,
    titleKey: "experiments.gloopieAvatarCreator.title",
    descriptionKey: "experiments.gloopieAvatarCreator.description",
    // Lets users generate a custom animated "gloopie" avatar from the agent
    // builder. Gated because generation calls the DAIM Apps service (requires
    // WARP), can take minutes, and writes generated media into the user avatar
    // store. No explicit default, so it follows the global auto-enable
    // preference: on in dev builds, off in production.
  },
  {
    id: AVATAR_COLLECTION_PAGE_EXPERIMENT_ID,
    titleKey: "experiments.avatarCollectionPage.title",
    descriptionKey: "experiments.avatarCollectionPage.description",
    // Replaces the inline avatar picker in the agent builder with a
    // full-surface, pannable collection canvas rendered as a frosted-glass
    // takeover. Purely a UI swap over the same avatar library state; no
    // backend authority. No explicit default, so it follows the global
    // auto-enable preference: on in dev builds, off in production.
  },
  {
    id: BERDY_ONBOARDING_EXPERIMENT_ID,
    titleKey: "experiments.berdyOnboarding.title",
    descriptionKey: "experiments.berdyOnboarding.description",
  },
  {
    id: FIRST_RUN_ONBOARDING_EXPERIMENT_ID,
    titleKey: "experiments.firstRunOnboarding.title",
    descriptionKey: "experiments.firstRunOnboarding.description",
    defaultEnabled: false,
    manualEnableOnly: true,
  },
] as const satisfies readonly ExperimentDefinition[];
