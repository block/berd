import { describe, expect, it } from "vitest";
import {
  GOOSE_HELP_SKILL_DRAFT,
  resolveGooseHelpSkill,
  shouldAutoInvokeGooseHelpSkill,
} from "./gooseHelpSkill";

describe("goose help skill routing", () => {
  it.each([
    "How do I get the custom agent avatars?",
    "My provider won't connect in the app",
    "Why is Goose stuck on this chat session?",
    "Where do I edit skills in Goose?",
    "Can you help me troubleshoot Doctor errors?",
    "How can I configure automations?",
    "Can I export my chat?",
    "Is there a way to export my session?",
  ])("auto-invokes for app help: %s", (text) => {
    expect(shouldAutoInvokeGooseHelpSkill(text)).toBe(true);
  });

  it.each([
    "How do I use React hooks?",
    "Fix this code",
    "Create an agent in my Python project",
    "Where is the settings file in this repository?",
    "/skill-builder create a troubleshooting skill",
    "Use workflowkit. Every Wednesday, pull our Slack, Linear (https://linear.app/squareup/initiative/foundational-automation-7490b7e2ce9d/overview), and GitHub activity (https://github.com/squareup/agents/pull/3840) for the block-workflow-kit project, group it into Shipped / In flight / Risks / Discussion, flag anything that mentions blocked or broken as a risk, and let me approve before it posts to #proj-bwk-wg.",
    "Create a weekly project status automation that flags anything mentioning blocked or broken.",
    "Debug the failing deploy mentioned in https://example.com/goose/settings.",
    "",
  ])("does not auto-invoke for unrelated work: %s", (text) => {
    expect(shouldAutoInvokeGooseHelpSkill(text)).toBe(false);
  });

  it("prefers the listed bundled skill when available", () => {
    const skill = {
      id: "global:/skills/goose-help",
      name: "goose-help",
      description: "Help with Goose",
      sourceLabel: "Global",
    };

    expect(
      resolveGooseHelpSkill("How do I change agent avatars?", [skill]),
    ).toBe(skill);
  });

  it("falls back to the built-in draft while skills are still loading", () => {
    expect(resolveGooseHelpSkill("How do I change agent avatars?", [])).toEqual(
      GOOSE_HELP_SKILL_DRAFT,
    );
  });
});
