import { describe, expect, it, vi } from "vitest";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { MAX_PROMPT_ATTACHMENT_BYTES } from "./attachmentPayloadBudget";
import { submitComposerMessage } from "./submitComposerMessage";

const mockToastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/shared/i18n", () => ({
  i18n: {
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  },
}));

function imageDraft(base64: string): ChatAttachmentDraft {
  return {
    id: crypto.randomUUID(),
    kind: "image",
    name: "photo.jpeg",
    mimeType: "image/jpeg",
    base64,
    previewUrl: "blob:preview",
  };
}

describe("submitComposerMessage", () => {
  it("adds skill instructions when a slash skill command matches", async () => {
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
    });

    expect(onSend).toHaveBeenCalledWith("review this", undefined, undefined, {
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "review this",
      assistantPrompt: "Use these skills for this request: code-review.",
    });
  });

  it("sends visible agent chips without changing the message text", async () => {
    const onSend = vi.fn().mockReturnValue(true);

    await submitComposerMessage({
      text: " ask both agents ",
      attachments: [],
      skills: [],
      chips: [
        { label: "Reviewer", type: "agent" },
        { label: "Solo", type: "agent" },
      ],
      selectedPersonaId: "solo",
      onSend,
      resolveSkillSlashCommand: () => null,
    });

    expect(onSend).toHaveBeenCalledWith("ask both agents", "solo", undefined, {
      chips: [
        { label: "Reviewer", type: "agent" },
        { label: "Solo", type: "agent" },
      ],
    });
  });

  it("keeps selected agent chips when skill chips are also present", async () => {
    const onSend = vi.fn().mockReturnValue(true);

    await submitComposerMessage({
      text: "review this",
      attachments: [],
      skills: [{ id: "global:/skills/code-review", name: "code-review" }],
      chips: [
        { label: "Reviewer", type: "agent" },
        { label: "Solo", type: "agent" },
      ],
      selectedPersonaId: "solo",
      onSend,
      resolveSkillSlashCommand: () => null,
    });

    expect(onSend).toHaveBeenCalledWith("review this", "solo", undefined, {
      chips: [
        { label: "Reviewer", type: "agent" },
        { label: "Solo", type: "agent" },
        { label: "code-review", type: "skill" },
      ],
      displayText: "review this",
      assistantPrompt: "Use these skills for this request: code-review.",
    });
  });

  it("rejects sends whose attachment payload exceeds the budget without calling onSend", async () => {
    mockToastError.mockClear();
    const onSend = vi.fn().mockReturnValue(true);

    const accepted = await submitComposerMessage({
      text: "look at these photos",
      attachments: [imageDraft("x".repeat(MAX_PROMPT_ATTACHMENT_BYTES + 1))],
      skills: [],
      onSend,
      resolveSkillSlashCommand: () => null,
    });

    expect(accepted).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(String(mockToastError.mock.calls[0][0])).toContain(
      "errors.attachmentsTooLarge",
    );
  });

  it("allows sends whose attachment payload is under the budget", async () => {
    mockToastError.mockClear();
    const onSend = vi.fn().mockReturnValue(true);

    const accepted = await submitComposerMessage({
      text: "one small photo",
      attachments: [imageDraft("x".repeat(1024))],
      skills: [],
      onSend,
      resolveSkillSlashCommand: () => null,
    });

    expect(accepted).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
