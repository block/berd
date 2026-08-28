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
  /** Limit this experiment's Settings controls without changing runtime state. */
  settingsVisibility?: "all" | "dev";
  config?: Record<string, ExperimentConfigControl>;
}

export const BUILDERBOT_SURFACE_EXPERIMENT_ID = "builderbot-surface";

export const VOICE_CONVERSATION_EXPERIMENT_ID = "voice-conversation";

export const TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID =
  "transcript-virtual-renderer";

export const CHAT_ON_CANVAS_EXPERIMENT_ID = "chat-on-canvas";

export const STARTER_TASKS_EXPERIMENT_ID = "onboarding-starter-tasks";

export const BERDY_ONBOARDING_EXPERIMENT_ID = "berdy-onboarding";

export const SKILL_DISCOVERY_EXPERIMENT_ID = "skill-discovery";

export const RELATED_PULL_REQUESTS_EXPERIMENT_ID = "related-pull-requests";

export const PROMPT_PINS_EXPERIMENT_ID = "prompt-pins";

export const REMOTE_SSH_SESSIONS_EXPERIMENT_ID = "remote-ssh-sessions";

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
    settingsVisibility: "dev",
  },
  {
    id: VOICE_CONVERSATION_EXPERIMENT_ID,
    titleKey: "experiments.voiceConversation.title",
    descriptionKey: "experiments.voiceConversation.description",
    defaultEnabled: true,
  },
  {
    id: CHAT_ON_CANVAS_EXPERIMENT_ID,
    titleKey: "experiments.chatOnCanvas.title",
    descriptionKey: "experiments.chatOnCanvas.description",
    defaultEnabled: false,
    manualEnableOnly: true,
  },
  {
    id: BERDY_ONBOARDING_EXPERIMENT_ID,
    titleKey: "experiments.berdyOnboarding.title",
    descriptionKey: "experiments.berdyOnboarding.description",
    settingsVisibility: "dev",
  },
  {
    id: RELATED_PULL_REQUESTS_EXPERIMENT_ID,
    titleKey: "experiments.relatedPullRequests.title",
    descriptionKey: "experiments.relatedPullRequests.description",
  },
  {
    id: PROMPT_PINS_EXPERIMENT_ID,
    titleKey: "experiments.promptPins.title",
    descriptionKey: "experiments.promptPins.description",
    // Gates only the widget picker's "Prompt" row; already-pinned prompts
    // keep rendering when disabled (user data is never hidden). No explicit
    // default, so it follows the global auto-enable preference: on in dev
    // builds, off in production.
  },
  {
    id: REMOTE_SSH_SESSIONS_EXPERIMENT_ID,
    titleKey: "experiments.remoteSshSessions.title",
    descriptionKey: "experiments.remoteSshSessions.description",
    // Opt-in only: connecting runs Goose on user-configured SSH hosts, so it
    // must never turn on via the dev auto-enable default.
    manualEnableOnly: true,
    settingsVisibility: "all",
  },
] as const satisfies readonly ExperimentDefinition[];
