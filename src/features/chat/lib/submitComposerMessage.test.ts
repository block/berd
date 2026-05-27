import { describe, expect, it, vi } from "vitest";
import { submitComposerMessage } from "./submitComposerMessage";
import type { ChatSkillDraft } from "../types";

const gooseHelpSkill: ChatSkillDraft = {
  id: "global:/skills/goose-help",
  name: "goose-help",
  sourceLabel: "Global",
};

describe("submitComposerMessage", () => {
  it("adds an automatic skill when the resolver matches", async () => {
    const onSend = vi.fn().mockReturnValue(true);

    await submitComposerMessage({
      text: "How do I get the custom agent avatars?",
      attachments: [],
      skills: [],
      onSend,
      resolveSkillSlashCommand: () => null,
      resolveAutoSkill: () => gooseHelpSkill,
    });

    expect(onSend).toHaveBeenCalledWith(
      "How do I get the custom agent avatars?",
      undefined,
      undefined,
      {
        chips: [{ label: "goose-help", type: "skill" }],
        displayText: "How do I get the custom agent avatars?",
        assistantPrompt: "Use these skills for this request: goose-help.",
      },
    );
  });

  it("does not auto-add a skill when a slash skill command matched", async () => {
    const onSend = vi.fn().mockReturnValue(true);

    await submitComposerMessage({
      text: "/skill-builder create a helper",
      attachments: [],
      skills: [],
      onSend,
      resolveSkillSlashCommand: () => ({
        skill: { id: "global:/skills/skill-builder", name: "skill-builder" },
        promptText: "Use the skill-builder skill to create a helper",
        displayText: "create a helper",
      }),
      resolveAutoSkill: () => gooseHelpSkill,
    });

    expect(onSend).toHaveBeenCalledWith(
      "create a helper",
      undefined,
      undefined,
      {
        chips: [{ label: "skill-builder", type: "skill" }],
        displayText: "create a helper",
        assistantPrompt: "Use these skills for this request: skill-builder.",
      },
    );
  });

  it("does not auto-add a skill when the user selected skills manually", async () => {
    const onSend = vi.fn().mockReturnValue(true);
    const selectedSkill = {
      id: "global:/skills/code-review",
      name: "code-review",
    };

    await submitComposerMessage({
      text: "review this",
      attachments: [],
      skills: [selectedSkill],
      onSend,
      resolveSkillSlashCommand: () => null,
      resolveAutoSkill: () => gooseHelpSkill,
    });

    expect(onSend).toHaveBeenCalledWith("review this", undefined, undefined, {
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "review this",
      assistantPrompt: "Use these skills for this request: code-review.",
    });
  });
});
