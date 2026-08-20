import type { TFunction } from "i18next";
import { graphemeCount } from "@/shared/lib/graphemeCount";
import {
  classifyAgentCardTraits,
  type AgentCardTraitId,
} from "./agentShareCardSpec";

export interface AgentShareCardCopy {
  goodForLabel: string;
  vibesLabel: string;
  goodFor: string;
  vibes: string;
}

interface AgentShareCardMetadata {
  goodFor?: string;
  vibes?: string;
}

export const AGENT_CARD_GOOD_FOR_MAX_GRAPHEMES = 44;
export const AGENT_CARD_VIBES_MAX_GRAPHEMES = 32;

function shortCardValue(value: string | undefined, maxGraphemes: number) {
  const trimmed = value?.trim();
  return trimmed && graphemeCount(trimmed) <= maxGraphemes
    ? trimmed
    : undefined;
}

function translated(t: TFunction<"agents">, key: string, fallback: string) {
  const value = t(key);
  return value === key ? fallback : value;
}

export function resolveAgentShareCardCopy(
  instructions: string,
  t: TFunction<"agents">,
  metadata: AgentShareCardMetadata = {},
): AgentShareCardCopy {
  const traitId: AgentCardTraitId = classifyAgentCardTraits(instructions);
  return {
    goodForLabel: translated(t, "share.cardLabels.goodFor", "Good for:"),
    vibesLabel: translated(t, "share.cardLabels.vibes", "Vibes:"),
    goodFor:
      shortCardValue(metadata.goodFor, AGENT_CARD_GOOD_FOR_MAX_GRAPHEMES) ||
      translated(t, `share.cardTraits.${traitId}.goodFor`, "focused work"),
    vibes:
      shortCardValue(metadata.vibes, AGENT_CARD_VIBES_MAX_GRAPHEMES) ||
      translated(t, `share.cardTraits.${traitId}.vibes`, "capable, thoughtful"),
  };
}
