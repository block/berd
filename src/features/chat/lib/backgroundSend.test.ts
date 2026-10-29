import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueuedSessionNotReadyError } from "./queuedMessageReadiness";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";

import { sendPromptInBackground } from "./backgroundSend";

const mocks = vi.hoisted(() => ({
  dispatchPrompt: vi.fn(),
}));

vi.mock("@/features/chat/lib/sendCore", () => ({
  dispatchPrompt: (...args: unknown[]) => mocks.dispatchPrompt(...args),
}));

describe("sendPromptInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatchPrompt.mockResolvedValue(undefined);
  });

  it("prioritizes the captured execution prompt over current persona context", async () => {
    await sendPromptInBackground(
      "session-1",
      "queued turn",
      "goose",
      {
        id: "current-persona",
        displayName: "Current Persona",
        systemPrompt: "current persona prompt",
      },
      {
        executionSystemPrompt: "captured persona and workspace prompt",
        systemPrompt: "current workspace prompt",
      },
    );

    expect(mocks.dispatchPrompt).toHaveBeenCalledWith(
      "session-1",
      "queued turn",
      expect.objectContaining({
        systemPrompt: "captured persona and workspace prompt",
      }),
    );
  });

  it.each([
    new QueuedSessionNotReadyError(),
    new QueuedMessageOwnershipLostError(),
  ])("rethrows expected pre-commit rejection without a failure log", async (error) => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.dispatchPrompt.mockRejectedValueOnce(error);

    await expect(
      sendPromptInBackground("session-1", "queued turn", "goose"),
    ).rejects.toBe(error);

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs true background send failures", async () => {
    const error = new Error("transport failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.dispatchPrompt.mockRejectedValueOnce(error);

    await expect(
      sendPromptInBackground("session-1", "queued turn", "goose"),
    ).rejects.toBe(error);

    expect(consoleError).toHaveBeenCalledWith(
      "[background-send] prompt failed for session session-1",
      error,
    );
  });
});
