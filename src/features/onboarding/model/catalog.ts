export const WORK_TYPE_IDS = [
  "engineering",
  "legal",
  "marketing",
  "product",
  "design",
  "writing",
  "not-sure",
] as const;

export type WorkTypeId = (typeof WORK_TYPE_IDS)[number];

const WORK_TYPE_ID_SET = new Set<string>(WORK_TYPE_IDS);

export function isWorkTypeId(value: string): value is WorkTypeId {
  return WORK_TYPE_ID_SET.has(value);
}

export interface WorkType {
  id: WorkTypeId;
}

// Presentation copy is keyed by these stable IDs in the onboarding locale.
export const WORK_TYPES: readonly WorkType[] = WORK_TYPE_IDS.map((id) => ({
  id,
}));

export interface RecommendedAgent {
  id: string;
  /** Canonical English identity used when generating the persisted persona. */
  canonicalName: string;
  /** Canonical English prompt fragment; never translated. */
  canonicalPromptDescription: string;
  avatar: `app-avatar:${string}`;
  workTypeIds: readonly WorkTypeId[];
}

export const RECOMMENDED_AGENTS: readonly RecommendedAgent[] = [
  {
    id: "planner",
    canonicalName: "Planner",
    canonicalPromptDescription:
      "A structured thinker for research and technical plans.",
    avatar: "app-avatar:gloopies-3",
    workTypeIds: ["product", "marketing"],
  },
  {
    id: "reviewer",
    canonicalName: "Reviewer",
    canonicalPromptDescription:
      "A careful second set of eyes for maintainable changes.",
    avatar: "app-avatar:gloopies-4",
    workTypeIds: ["design", "engineering"],
  },
  {
    id: "automator",
    canonicalName: "Automator",
    canonicalPromptDescription:
      "A workflow specialist for repetitive engineering tasks.",
    avatar: "app-avatar:gloopies-14",
    workTypeIds: ["marketing", "writing"],
  },
  {
    id: "explorer",
    canonicalName: "Explorer",
    canonicalPromptDescription:
      "A research companion for unfamiliar systems and choices.",
    avatar: "app-avatar:gloopies-15",
    workTypeIds: ["legal", "design"],
  },
];

const agentOrder = new Map(
  RECOMMENDED_AGENTS.map((agent, index) => [agent.id, index]),
);

export function recommendationsForWorkTypes(
  workTypeIds: readonly WorkTypeId[],
): RecommendedAgent[] {
  const selected = new Set(workTypeIds);
  return RECOMMENDED_AGENTS.map((agent) => ({
    agent,
    score: agent.workTypeIds.reduce(
      (total, workTypeId) => total + (selected.has(workTypeId) ? 1 : 0),
      0,
    ),
  }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        (agentOrder.get(left.agent.id) ?? 0) -
          (agentOrder.get(right.agent.id) ?? 0),
    )
    .slice(0, 3)
    .map(({ agent }) => agent);
}

export const CURATED_HARNESS_IDS = [
  "goose",
  "claude-acp",
  "codex-acp",
  "copilot-acp",
  "amp-acp",
  "cursor-agent",
  "pi-acp",
] as const;

export type CuratedHarnessId = (typeof CURATED_HARNESS_IDS)[number];
