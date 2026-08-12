import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { MAX_PROMPT_ATTACHMENT_BYTES } from "../attachmentPayloadBudget";

const mockAcpSteerMessage = vi.fn();

vi.mock("@/shared/api/acp", () => ({
  acpSteerMessage: (...args: unknown[]) => mockAcpSteerMessage(...args),
}));

vi.mock("@/shared/i18n", () => ({
  i18n: {
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  },
}));

import { steerPromptInSession } from "../steerCore";

function oversizedImageDraft() {
  return {
    id: "image-1",
    kind: "image" as const,
    name: "huge.jpeg",
    mimeType: "image/jpeg",
    base64: "x".repeat(MAX_PROMPT_ATTACHMENT_BYTES + 1),
    previewUrl: "blob:huge",
  };
}

describe("steerPromptInSession payload budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      activeSessionId: null,
      isConnected: true,
    });
  });

  it("rejects an over-budget steer before committing anything", async () => {
    // Discriminating test for the steer-side budget guard: non-composer
    // callers (berdctl, queued steers) reach steerPromptInSession directly,
    // where an oversized ACP message would silently kill the shared
    // WebSocket and every open chat with it (BOT-1463). Pre-guard code
    // commits the user message and calls acpSteerMessage; guarded code
    // must do neither.
    const accepted = await steerPromptInSession("session-1", "look at this", [
      oversizedImageDraft(),
    ]);

    expect(accepted).toBe(false);
    expect(mockAcpSteerMessage).not.toHaveBeenCalled();

    // The failure is visible, not silent: a system error notification is
    // the only message added — no user message lands in the transcript.
    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).not.toBe("user");
    expect(messages[0].content[0]).toMatchObject({
      text: expect.stringContaining("errors.attachmentsTooLarge"),
    });
  });

  it("throws for throwOnError callers so berdctl reports the rejection", async () => {
    await expect(
      steerPromptInSession(
        "session-1",
        "look at this",
        [oversizedImageDraft()],
        undefined,
        { throwOnError: true },
      ),
    ).rejects.toThrow(/attachmentsTooLarge/);
    expect(mockAcpSteerMessage).not.toHaveBeenCalled();
  });

  it("passes an under-budget steer through to the ACP call", async () => {
    mockAcpSteerMessage.mockResolvedValue({
      runId: "run-1",
      messageId: "msg-1",
    });

    const accepted = await steerPromptInSession("session-1", "small one", [
      { ...oversizedImageDraft(), base64: "x".repeat(1024) },
    ]);

    expect(accepted).toBe(true);
    expect(mockAcpSteerMessage).toHaveBeenCalledTimes(1);
  });
});
