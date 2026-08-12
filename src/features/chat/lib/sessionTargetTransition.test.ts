import { beforeEach, describe, expect, it, vi } from "vitest";
import { transitionSessionTarget } from "./sessionTargetCoordinator";
import { resetSessionTargetCoordinatorsForTests } from "./sessionTargetCoordinator";

const mockAcpPrepareSession = vi.fn();

vi.mock("@/shared/api/acp", () => ({
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
}));

function target(harnessId: string, modelId: string) {
  return { harnessId, modelProviderId: harnessId, modelId, modelName: modelId };
}

describe("transitionSessionTarget", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    vi.clearAllMocks();
    mockAcpPrepareSession.mockResolvedValue(undefined);
  });

  it("coalesces requests that have not crossed the wire", async () => {
    const oldResult = transitionSessionTarget({
      sessionId: "session-latest",
      target: target("old-provider", "old-model"),
      workingDir: "/old",
    });
    const newResult = transitionSessionTarget({
      sessionId: "session-latest",
      target: target("new-provider", "new-model"),
      workingDir: "/new",
    });

    await expect(oldResult).resolves.toMatchObject({ applied: false });
    await expect(newResult).resolves.toMatchObject({ applied: true });
    expect(mockAcpPrepareSession).toHaveBeenCalledOnce();
    expect(mockAcpPrepareSession).toHaveBeenCalledWith(
      "session-latest",
      "new-provider",
      "/new",
      { modelId: "new-model" },
    );
  });

  it("forwards the owning request id with the provider-qualified model", async () => {
    await transitionSessionTarget({
      sessionId: "session-owned",
      target: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-6-sol",
        modelName: "GPT-5.6 Sol",
      },
      workingDir: "/project",
      requestId: "request-5-6",
      requireReasoningEffort: true,
    });

    expect(mockAcpPrepareSession).toHaveBeenCalledWith(
      "session-owned",
      "databricks_v2",
      "/project",
      {
        modelId: "goose-gpt-5-6-sol",
        forceConfigRefresh: true,
        requestId: "request-5-6",
      },
    );
  });
});
