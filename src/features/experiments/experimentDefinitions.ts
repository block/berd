import type { Platform } from "@/shared/lib/platform";

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
    }
  | {
      type: "shortcut";
      labelKey: string;
      descriptionKey?: string;
      defaultValue: string;
    };

export interface ExperimentDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  /** Default state for users without an explicit per-experiment override. */
  defaultEnabled?: boolean;
  /** Omit the experiment outside these runtime platforms. */
  platforms?: readonly Platform[];
  config?: Record<string, ExperimentConfigControl>;
}

export const BUILDERBOT_SURFACE_EXPERIMENT_ID = "builderbot-surface";

export const GLOBAL_SHORTCUT_EXPERIMENT_ID = "global-shortcut";

export const PANE_JUMP_NAVIGATION_EXPERIMENT_ID = "pane-jump-navigation";
export const DEFAULT_PANE_JUMP_NAVIGATION_SHORTCUT = "ctrl+;";

export const TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID =
  "transcript-virtual-renderer";

export const AGENT_WORK_TRANSCRIPT_EXPERIMENT_ID = "agent-work-transcript";

export const SESSION_COST_EXPERIMENT_ID = "session-cost-display";

export const LOCAL_MARKDOWN_IMAGES_EXPERIMENT_ID = "local-markdown-images";

export const SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID =
  "sidebar-detachable-chats";

export const SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID = "sidebar-flat-chat-list";
export const NAVIGATION_REFRESH_EXPERIMENT_ID = "navigation-refresh";
export const SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY =
  "groupChatsByProject";
export const DEFAULT_SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT = true;

export const EXPERIMENT_DEFINITIONS = [
  {
    id: BUILDERBOT_SURFACE_EXPERIMENT_ID,
    titleKey: "experiments.builderbot.title",
    descriptionKey: "experiments.builderbot.description",
  },
  {
    id: PANE_JUMP_NAVIGATION_EXPERIMENT_ID,
    titleKey: "experiments.paneJumpNavigation.title",
    descriptionKey: "experiments.paneJumpNavigation.description",
    config: {
      shortcut: {
        type: "shortcut",
        labelKey: "experiments.paneJumpNavigation.shortcutLabel",
        descriptionKey: "experiments.paneJumpNavigation.shortcutDescription",
        defaultValue: DEFAULT_PANE_JUMP_NAVIGATION_SHORTCUT,
      },
    },
  },
  {
    id: TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
    titleKey: "experiments.transcriptVirtualRenderer.title",
    descriptionKey: "experiments.transcriptVirtualRenderer.description",
    defaultEnabled: true,
  },
  {
    id: AGENT_WORK_TRANSCRIPT_EXPERIMENT_ID,
    titleKey: "experiments.agentWorkTranscript.title",
    descriptionKey: "experiments.agentWorkTranscript.description",
    defaultEnabled: false,
  },
  {
    id: SESSION_COST_EXPERIMENT_ID,
    titleKey: "experiments.sessionCost.title",
    descriptionKey: "experiments.sessionCost.description",
    // Always off unless the user explicitly opts in. Pinning defaultEnabled
    // to false makes the "auto" state off even in dev builds (where the global
    // auto-enable is on) and after a reset-to-auto, so the cost number never
    // shows by default.
    defaultEnabled: false,
  },
  {
    id: LOCAL_MARKDOWN_IMAGES_EXPERIMENT_ID,
    titleKey: "experiments.localMarkdownImages.title",
    descriptionKey: "experiments.localMarkdownImages.description",
    // Renders Markdown image links that point at local files in the session
    // working directory inline (via the asset: scheme), instead of showing a
    // broken image. Off by default until the path-scoping behavior is reviewed;
    // remote http(s) images stay blocked regardless of this switch.
    defaultEnabled: false,
  },
  {
    id: SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID,
    titleKey: "experiments.sidebarDetachableChats.title",
    descriptionKey: "experiments.sidebarDetachableChats.description",
  },
  {
    id: NAVIGATION_REFRESH_EXPERIMENT_ID,
    titleKey: "experiments.navigationRefresh.title",
    descriptionKey: "experiments.navigationRefresh.description",
  },
  {
    id: SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
    titleKey: "experiments.sidebarFlatChatList.title",
    descriptionKey: "experiments.sidebarFlatChatList.description",
    defaultEnabled: true,
    config: {
      [SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY]: {
        type: "boolean",
        labelKey: "general.groupChatsByProject.label",
        descriptionKey: "general.groupChatsByProject.description",
        defaultValue: DEFAULT_SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT,
      },
    },
  },
  {
    id: GLOBAL_SHORTCUT_EXPERIMENT_ID,
    titleKey: "experiments.globalShortcut.title",
    descriptionKey: "experiments.globalShortcut.description",
    config: {
      shortcut: {
        type: "shortcut",
        labelKey: "experiments.globalShortcut.shortcutLabel",
        defaultValue: "alt+space",
      },
    },
    defaultEnabled: false,
    platforms: ["mac"],
  },
] as const satisfies readonly ExperimentDefinition[];
