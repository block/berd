import { describe, expect, it } from "vitest";
import {
  resolveAgentToolsCapabilityTip,
  resolveAgentToolsCapabilityTips,
} from "./agentToolsCapabilities";
import type { SkillMentionItem } from "../ui/mentionDetection";

const AGENT_TOOLS_SKILL: SkillMentionItem = {
  id: "global:/skills/sq-agent-tools",
  name: "sq-agent-tools",
  description: "Use to interact with Block's internal tools via sq agent-tools",
  sourceLabel: "Personal",
};

describe("agent tools capabilities", () => {
  it("resolves the latest mentioned managed tool", () => {
    expect(
      resolveAgentToolsCapabilityTip("slack asana", [AGENT_TOOLS_SKILL]),
    ).toMatchObject({ provider: "asana", label: "Asana" });
  });

  it("prefers the most specific overlapping alias at the same position", () => {
    expect(
      resolveAgentToolsCapabilityTip("salesforce sq", [AGENT_TOOLS_SKILL]),
    ).toMatchObject({
      provider: "salesforce-sq",
      label: "Salesforce (Square)",
    });
  });

  it("returns all mentioned managed tools in mention order", () => {
    expect(
      resolveAgentToolsCapabilityTips("slack linear asana", [
        AGENT_TOOLS_SKILL,
      ]).map((tip) => tip.provider),
    ).toEqual(["slack", "linear", "asana"]);
  });
});
