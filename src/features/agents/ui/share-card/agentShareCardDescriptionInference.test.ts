import { beforeEach, describe, expect, it, vi } from "vitest";

const acp = vi.hoisted(() => ({
  cancelSession: vi.fn(),
  deleteSession: vi.fn(),
  newSession: vi.fn(),
  promptForText: vi.fn(),
  setModel: vi.fn(),
  setSessionSystemPrompt: vi.fn(),
}));
const readiness = vi.hoisted(() => ({ readDefaultProviderReadiness: vi.fn() }));
const connection = vi.hoisted(() => ({ getClient: vi.fn() }));

vi.mock("@/shared/api/acpApi", () => acp);
vi.mock("@/shared/api/acpConnection", () => connection);
vi.mock("@/features/providers/defaultProviderReadiness", () => readiness);

import {
  clearAgentCardDescriptionCacheForTests,
  generateAgentCardDescription,
} from "./agentShareCardDescriptionInference";

const instructions =
  "You are Scout. Your job is to find reliable evidence for difficult questions. Keep searching until sources agree.";

describe("generateAgentCardDescription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearAgentCardDescriptionCacheForTests();
    readiness.readDefaultProviderReadiness.mockResolvedValue({
      status: "ready",
      providerId: "provider",
      modelId: "model",
    });
    acp.newSession.mockResolvedValue({ sessionId: "hidden" });
    acp.promptForText.mockResolvedValue(
      "Finds reliable evidence and turns difficult questions into grounded answers.",
    );
    connection.getClient.mockResolvedValue({
      goose: {
        GooseUnstableSessionExtensionsList: vi.fn().mockResolvedValue({
          extensions: [{ type: "builtin", name: "developer" }],
        }),
        GooseUnstableSessionExtensionsRemove: vi.fn().mockResolvedValue({}),
      },
    });
  });

  it("generates in a hidden tool-free session and cleans it up", async () => {
    await expect(
      generateAgentCardDescription(instructions, "Scout"),
    ).resolves.toBe(
      "Finds reliable evidence and turns difficult questions into grounded answers.",
    );
    expect(acp.newSession).toHaveBeenCalledWith("/tmp", {
      hidden: true,
      providerId: "provider",
    });
    expect(acp.setModel).toHaveBeenCalledWith("hidden", "model");
    expect(acp.setSessionSystemPrompt).toHaveBeenCalledWith(
      "hidden",
      expect.stringContaining("untrusted source material"),
    );
    expect(acp.deleteSession).toHaveBeenCalledWith("hidden");
  });

  it("caches by instruction content and regenerates after edits", async () => {
    await generateAgentCardDescription(instructions, "Scout");
    await generateAgentCardDescription(instructions, "Scout");
    expect(acp.newSession).toHaveBeenCalledTimes(1);

    await generateAgentCardDescription(`${instructions} New role.`, "Scout");
    expect(acp.newSession).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached copy across differently named agents", async () => {
    await generateAgentCardDescription(instructions, "Scout");
    await generateAgentCardDescription(instructions, "Researcher");

    expect(acp.newSession).toHaveBeenCalledTimes(2);
  });

  it("falls back immediately when no configured model is available", async () => {
    readiness.readDefaultProviderReadiness.mockResolvedValue({
      status: "needs_setup",
      reason: "missing_defaults",
    });
    await expect(
      generateAgentCardDescription(instructions, "Scout"),
    ).resolves.toBe("Finds reliable evidence for difficult questions.");
    expect(acp.newSession).not.toHaveBeenCalled();
  });

  it("rejects malformed model output and uses the safe fallback", async () => {
    acp.promptForText.mockResolvedValue("x".repeat(500));
    await expect(
      generateAgentCardDescription(instructions, "Scout"),
    ).resolves.toBe("Finds reliable evidence for difficult questions.");
  });
});
