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
      placeholderKey?: string;
    };

export interface ExperimentDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  config?: Record<string, ExperimentConfigControl>;
}

export const BUILDERBOT_SURFACE_EXPERIMENT_ID = "builderbot-surface";

export const GOOSE_STYLE_GUIDELINES_EXPERIMENT_ID = "goose-style-guidelines";

export const PANE_JUMP_NAVIGATION_EXPERIMENT_ID = "pane-jump-navigation";
export const DEFAULT_PANE_JUMP_NAVIGATION_SHORTCUT = "ctrl+;";

export const DEFAULT_GOOSE_STYLE_GUIDELINES_PROMPT = `Response style:
- Be concise, direct, and friendly; avoid unnecessary detail unless the user asks for it.
- Keep progress updates short and focused on the immediate work or next step.
- For simple answers or small changes, use plain sentences or a short list instead of heavy structure.
- For final responses, lead with the outcome, mention verification or blockers, and stay compact by default.
- Expand only when extra detail is needed for correctness or user understanding.`;

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
        placeholderKey: "experiments.paneJumpNavigation.shortcutPlaceholder",
      },
    },
  },
  {
    id: GOOSE_STYLE_GUIDELINES_EXPERIMENT_ID,
    titleKey: "experiments.gooseStyleGuidelines.title",
    descriptionKey: "experiments.gooseStyleGuidelines.description",
    config: {
      prompt: {
        type: "text",
        labelKey: "experiments.gooseStyleGuidelines.promptLabel",
        descriptionKey: "experiments.gooseStyleGuidelines.promptDescription",
        defaultValue: DEFAULT_GOOSE_STYLE_GUIDELINES_PROMPT,
        placeholderKey: "experiments.gooseStyleGuidelines.promptPlaceholder",
      },
    },
  },
] as const satisfies readonly ExperimentDefinition[];
