import type { CapabilityDescriptor } from "@/app/capabilities/types";

export type AgentBuilderRenderMode = "chatRail";

export const agentBuilderCapabilityDescriptor = {
  id: "agentBuilder",
  name: "Agent Builder",
  description:
    "Create and edit file-backed agents from a session-scoped workflow.",
  owningFeature: "agents",
  renderModes: ["chatRail"],
  requiredContext: ["session"],
  states: ["preparing", "editing", "saving", "failed", "closed"],
  actions: [
    "changeTarget",
    "recoverDraft",
    "saveDraft",
    "promoteDraft",
    "completeEdit",
    "refreshPersonas",
    "close",
  ],
} as const satisfies CapabilityDescriptor<AgentBuilderRenderMode>;
