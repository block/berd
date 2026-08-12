import type { ProviderTemplate } from "@/features/providers/ui/CustomProviderForm";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

export const PROMOTED_PROVIDER_IDS = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
] as const;

const DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  google: "Gemini",
  databricks: "Databricks Model Serving",
  databricks_v2: "Databricks",
};

export interface SetupProviderChoice {
  kind: "setup";
  id: string;
  displayName: string;
  description: string;
  entry: ProviderCatalogEntry;
}

export interface TemplateProviderChoice {
  kind: "template";
  id: string;
  displayName: string;
  description?: string;
  template: ProviderTemplate;
}

export type ProviderDirectoryChoice =
  | SetupProviderChoice
  | TemplateProviderChoice;

function canonicalProviderId(id: string): string {
  return id.trim().toLowerCase();
}

export function providerDisplayName(id: string, fallback: string): string {
  return DISPLAY_NAME_OVERRIDES[canonicalProviderId(id)] ?? fallback;
}

/**
 * Combines model setup providers with custom-provider templates. Setup entries
 * take precedence when both sources identify the same provider.
 */
export function mergeProviderChoices(
  setupEntries: readonly ProviderCatalogEntry[],
  templates: readonly ProviderTemplate[],
): ProviderDirectoryChoice[] {
  const setupIds = new Set<string>();
  const setupChoices: SetupProviderChoice[] = [];
  for (const entry of setupEntries) {
    if (entry.category !== "model") {
      continue;
    }
    const canonicalId = canonicalProviderId(entry.id);
    if (setupIds.has(canonicalId)) {
      continue;
    }
    setupIds.add(canonicalId);
    for (const alias of entry.aliases ?? []) {
      setupIds.add(canonicalProviderId(alias));
    }
    setupChoices.push({
      kind: "setup",
      id: entry.id,
      displayName: providerDisplayName(entry.id, entry.displayName),
      description: entry.description,
      entry,
    });
  }

  const seenTemplateIds = new Set<string>();
  const templateChoices: TemplateProviderChoice[] = [];
  for (const template of templates) {
    const canonicalId = canonicalProviderId(template.id);
    if (setupIds.has(canonicalId) || seenTemplateIds.has(canonicalId)) {
      continue;
    }
    seenTemplateIds.add(canonicalId);
    templateChoices.push({
      kind: "template",
      id: template.id,
      displayName: providerDisplayName(template.id, template.displayName),
      description: template.description,
      template,
    });
  }

  return [...setupChoices, ...templateChoices];
}

function searchableText(choice: ProviderDirectoryChoice): string {
  const common = [choice.displayName, choice.id, choice.description ?? ""];

  if (choice.kind === "setup") {
    return [
      ...common,
      choice.entry.displayName,
      ...(choice.entry.aliases ?? []),
    ]
      .join(" ")
      .toLowerCase();
  }

  return [
    ...common,
    choice.template.displayName,
    choice.template.engine,
    ...choice.template.models,
  ]
    .join(" ")
    .toLowerCase();
}

export function searchProviderChoices(
  choices: readonly ProviderDirectoryChoice[],
  query: string,
): ProviderDirectoryChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...choices];
  }

  return choices.filter((choice) => searchableText(choice).includes(needle));
}

/**
 * Returns available promoted providers in product order, followed by connected
 * non-promoted providers in their existing directory order.
 */
export function selectPromotedAndConnectedProviderChoices(
  choices: readonly ProviderDirectoryChoice[],
  connectedProviderIds: ReadonlySet<string> | readonly string[],
): ProviderDirectoryChoice[] {
  const byId = new Map(
    choices.map((choice) => [canonicalProviderId(choice.id), choice]),
  );
  const promotedIds = new Set<string>(PROMOTED_PROVIDER_IDS);
  const connectedIds = new Set(
    [...connectedProviderIds].map(canonicalProviderId),
  );

  const promoted = PROMOTED_PROVIDER_IDS.flatMap((id) => {
    const choice = byId.get(id);
    return choice ? [choice] : [];
  });
  const connectedNonPromoted = choices.filter((choice) => {
    const id = canonicalProviderId(choice.id);
    return connectedIds.has(id) && !promotedIds.has(id);
  });

  return [...promoted, ...connectedNonPromoted];
}
