import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";

vi.mock("@/shared/api/acp", () => ({
  acpLoadSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/acpNotificationHandler", () => ({
  getReplayPerf: () => undefined,
  clearReplayPerf: vi.fn(),
}));

import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";

describe("loadSessionMessages", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
    } as never);
  });

  it("skips loading when the session already has messages", async () => {
    const { acpLoadSession } = await import("@/shared/api/acp");
    useChatStore.setState({
      messagesBySession: { s1: [{ id: "m1" } as never] },
    } as never);

    await loadSessionMessages("s1");

    expect(acpLoadSession).not.toHaveBeenCalled();
  });

  it("calls acpLoadSession when there are no messages yet", async () => {
    const { acpLoadSession } = await import("@/shared/api/acp");

    await loadSessionMessages("s2");

    expect(acpLoadSession).toHaveBeenCalledWith("s2", expect.any(String));
  });
});
