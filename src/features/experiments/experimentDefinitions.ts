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

export const MULTI_WORKSPACE_EXPERIMENT_ID = "multi-workspace";

export const TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID =
  "transcript-virtual-renderer";

export const LOCAL_MARKDOWN_IMAGES_EXPERIMENT_ID = "local-markdown-images";

export const SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID =
  "sidebar-detachable-chats";

export const NAVIGATION_REFRESH_EXPERIMENT_ID = "navigation-refresh";
export const NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID =
  "navigation-chats-under-projects";

export const SKILL_DISCOVERY_EXPERIMENT_ID = "skill-discovery";

export const EXPERIMENT_DEFINITIONS = [
  {
    id: BUILDERBOT_SURFACE_EXPERIMENT_ID,
    titleKey: "experiments.builderbot.title",
    descriptionKey: "experiments.builderbot.description",
  },
  {
    id: MULTI_WORKSPACE_EXPERIMENT_ID,
    titleKey: "experiments.multiWorkspace.title",
    descriptionKey: "experiments.multiWorkspace.description",
  },
  {
    id: TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
    titleKey: "experiments.transcriptVirtualRenderer.title",
    descriptionKey: "experiments.transcriptVirtualRenderer.description",
    defaultEnabled: true,
  },
  {
    id: LOCAL_MARKDOWN_IMAGES_EXPERIMENT_ID,
    titleKey: "experiments.localMarkdownImages.title",
    descriptionKey: "experiments.localMarkdownImages.description",
    // Renders Markdown image links that point at local files in the session
    // working directory inline (via the asset: scheme), instead of showing a
    // broken image. Deliberately off by default — rendering local files is
    // opt-in. When off, MarkdownImage shows an inline enable hint where the
    // image would render, so the toggle is discoverable in context. Remote
    // http(s) images stay blocked regardless of this switch.
    defaultEnabled: false,
  },
  {
    id: SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID,
    titleKey: "experiments.sidebarDetachableChats.title",
    descriptionKey: "experiments.sidebarDetachableChats.description",
    defaultEnabled: false,
  },
  {
    id: NAVIGATION_REFRESH_EXPERIMENT_ID,
    titleKey: "experiments.navigationRefresh.title",
    descriptionKey: "experiments.navigationRefresh.description",
  },
  {
    id: NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
    titleKey: "experiments.navigationChatsUnderProjects.title",
    descriptionKey: "experiments.navigationChatsUnderProjects.description",
    defaultEnabled: false,
  },
  {
    id: SKILL_DISCOVERY_EXPERIMENT_ID,
    titleKey: "experiments.skillDiscovery.title",
    descriptionKey: "experiments.skillDiscovery.description",
    // Skill discovery is an opt-in surface because it requires the optional
    // sq-agents CLI and can make remote catalog requests.
    defaultEnabled: false,
  },
] as const satisfies readonly ExperimentDefinition[];
