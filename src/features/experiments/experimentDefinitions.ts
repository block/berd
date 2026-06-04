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
    };

export interface ExperimentDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  config?: Record<string, ExperimentConfigControl>;
}

export const BUILDERBOT_SURFACE_EXPERIMENT_ID = "builderbot-surface";

export const MULTI_WINDOW_EXPERIMENT_ID = "multi-window";

export const GOOSE_STYLE_GUIDELINES_EXPERIMENT_ID = "goose-style-guidelines";

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
    id: MULTI_WINDOW_EXPERIMENT_ID,
    titleKey: "experiments.multiWindow.title",
    descriptionKey: "experiments.multiWindow.description",
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
