import type { TFunction } from "i18next";
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

export function resolveAgentShareCardCopy(
  instructions: string,
  t: TFunction<"agents">,
): AgentShareCardCopy {
  const traitId: AgentCardTraitId = classifyAgentCardTraits(instructions);
  return {
    goodForLabel: t("share.cardLabels.goodFor"),
    vibesLabel: t("share.cardLabels.vibes"),
    goodFor: t(`share.cardTraits.${traitId}.goodFor`),
    vibes: t(`share.cardTraits.${traitId}.vibes`),
  };
}
