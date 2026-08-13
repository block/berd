export const AGENT_CARD_WIDTH = 1227;
export const AGENT_CARD_HEIGHT = 1839;
export const AGENT_CARD_ASPECT_RATIO = `${AGENT_CARD_WIDTH}/${AGENT_CARD_HEIGHT}`;

const MAX_TITLE_CHARACTERS = 26;

export function truncateAgentCardTitle(name: string): string {
  const title = name.trim().toLocaleUpperCase() || "BERD AGENT";
  const characters = Array.from(title);
  return characters.length > MAX_TITLE_CHARACTERS
    ? `${characters.slice(0, MAX_TITLE_CHARACTERS - 1).join("")}…`
    : title;
}

export function stableAgentCardNumber(identity: string): string {
  let hash = 0;
  for (const character of identity) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return String(hash % 10_000).padStart(4, "0");
}

export interface AgentCardTraits {
  goodFor: string;
  vibes: string;
}

interface TraitRule extends AgentCardTraits {
  keywords: readonly string[];
}

const TRAIT_RULES: readonly TraitRule[] = [
  {
    keywords: [
      "code",
      "coding",
      "software",
      "developer",
      "programming",
      "implement",
      "debug",
    ],
    goodFor: "building and improving software",
    vibes: "precise, pragmatic",
  },
  {
    keywords: ["review", "audit", "risk", "quality", "security", "critique"],
    goodFor: "spotting risks and raising quality",
    vibes: "sharp, dependable",
  },
  {
    keywords: [
      "research",
      "investigate",
      "search",
      "source",
      "evidence",
      "discover",
    ],
    goodFor: "finding and synthesizing answers",
    vibes: "curious, thorough",
  },
  {
    keywords: [
      "write",
      "writing",
      "draft",
      "edit",
      "copy",
      "content",
      "summarize",
    ],
    goodFor: "turning ideas into clear words",
    vibes: "clear, thoughtful",
  },
  {
    keywords: [
      "design",
      "visual",
      "interface",
      "ux",
      "ui",
      "prototype",
      "creative",
    ],
    goodFor: "shaping useful, polished experiences",
    vibes: "creative, intentional",
  },
  {
    keywords: [
      "plan",
      "planning",
      "strategy",
      "roadmap",
      "organize",
      "coordinate",
    ],
    goodFor: "turning goals into practical plans",
    vibes: "organized, strategic",
  },
  {
    keywords: [
      "automate",
      "automation",
      "workflow",
      "repetitive",
      "script",
      "schedule",
    ],
    goodFor: "streamlining repetitive work",
    vibes: "efficient, resourceful",
  },
  {
    keywords: [
      "data",
      "analyze",
      "analysis",
      "metric",
      "sql",
      "report",
      "insight",
    ],
    goodFor: "making sense of complex data",
    vibes: "analytical, precise",
  },
  {
    keywords: ["help", "support", "troubleshoot", "guide", "explain", "teach"],
    goodFor: "untangling problems and helping people",
    vibes: "patient, resourceful",
  },
];

/**
 * Produces short, stable card copy locally from an agent's instructions.
 * Word-boundary matches keep incidental substrings from changing the result;
 * ties preserve the curated rule order so the same instructions always render
 * the same card.
 */
export function deriveAgentCardTraits(instructions: string): AgentCardTraits {
  const normalized = instructions.toLocaleLowerCase();
  let bestRule: TraitRule | undefined;
  let bestScore = 0;

  for (const rule of TRAIT_RULES) {
    const score = rule.keywords.reduce((total, keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (
        total + (new RegExp(`\\b${escaped}\\b`, "u").test(normalized) ? 1 : 0)
      );
    }, 0);
    if (score > bestScore) {
      bestRule = rule;
      bestScore = score;
    }
  }

  return bestRule
    ? { goodFor: bestRule.goodFor, vibes: bestRule.vibes }
    : {
        goodFor: "making progress on focused work",
        vibes: "capable, thoughtful",
      };
}
