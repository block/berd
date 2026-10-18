import { PreCommitSendRejectedError } from "./preCommitSendRejection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acpGetPreparedWorkingDir,
  acpPrepareSession,
  acpSetSessionConfigOption,
} from "@/shared/api/acp";
import { routeAutoModel } from "@/shared/api/autoRouting";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import { prepareAutoRoutedPrompt } from "./autoRoutingDispatch";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
} from "./sessionTargetCoordinator";

vi.mock("@/shared/api/acp", () => ({
  acpGetPreparedWorkingDir: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSetSessionConfigOption: vi.fn(),
}));
vi.mock("@/shared/api/autoRouting", () => ({ routeAutoModel: vi.fn() }));

const decision = {
  modeId: "balanced",
  source: "router" as const,
  modelProviderId: "openai",
  modelId: "chosen",
  effort: "max" as const,
  rationale: "Complex task",
  response: { full: "diagnostic" },
};
describe("auto routing dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpGetPreparedWorkingDir).mockReturnValue("/work");
    resetSessionTargetCoordinatorsForTests();
    useRuntimeConfigStore.setState({
      config: {
        ...DEFAULT_RUNTIME_CONFIG,
        goose: {
          ...DEFAULT_RUNTIME_CONFIG.goose,
          autoRouting: {
            url: "https://example.com/route",
            modes: [
              {
                id: "balanced",
                displayName: "Auto (balanced)",
                modelProviderId: "openai",
                fallback: { modelId: "chosen", effort: "high" },
                models: [
                  {
                    modelId: "chosen",
                    routerModel: "system.ai.chosen",
                    minEffort: "high",
                    maxEffort: "max",
                  },
                ],
              },
            ],
          },
        },
      },
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s",
          title: "Chat",
          autoModeId: "balanced",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "previous",
            modelName: "Previous",
          },
          workingDir: "/work",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          messageCount: 0,
        },
      ],
    });
    useChatStore.setState({ messagesBySession: {} });
    vi.mocked(routeAutoModel).mockImplementation(async () => ({ ...decision }));
    vi.mocked(acpPrepareSession).mockResolvedValue({
      model: { modelId: "chosen", modelName: "Chosen" },
      reasoningEffort: {
        configId: "thinking",
        currentValue: "medium",
        options: [
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
      },
    });
    vi.mocked(acpSetSessionConfigOption).mockResolvedValue({
      model: null,
      reasoningEffort: null,
    });
  });

  it("routes each new prompt, applies the supported bounded effort, and retains full diagnostics", async () => {
    for (const text of ["First task", "Follow-up task"]) {
      const lease = acquireSessionDispatchTarget("s");
      if (lease.status !== "acquired") throw new Error("Expected lease");
      const result = await prepareAutoRoutedPrompt("s", {
        text,
        assistantPrompt: "Loaded SKILL.md instructions",
        dispatchToken: lease.token,
      });
      expect(result).toMatchObject({
        modelId: "chosen",
        effortApplied: "high",
        response: decision.response,
      });
      lease.release();
    }
    expect(routeAutoModel).toHaveBeenCalledTimes(2);
    expect(routeAutoModel).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Loaded SKILL.md instructions"),
      }),
    );
    expect(acpSetSessionConfigOption).toHaveBeenCalledWith(
      "s",
      "thinking",
      "high",
      expect.objectContaining({ modelId: "chosen" }),
    );
    expect(useChatSessionStore.getState().getSession("s")).toMatchObject({
      autoModeId: "balanced",
      executionTarget: { modelId: "chosen" },
      autoRoutingDecision: { effortApplied: "high" },
    });
  });

  it("retains the prepared artifact CWD when routing a workspace-free chat", async () => {
    useChatSessionStore.getState().patchSession("s", { workingDir: undefined });
    useChatSessionStore.setState({ activeWorkspaceBySession: {} });
    const preparedCwd = "/Users/example/.berd/artifacts/session";
    vi.mocked(acpGetPreparedWorkingDir).mockReturnValue(preparedCwd);
    vi.mocked(acpPrepareSession).mockImplementation(
      async (_id, _provider, cwd) => {
        // Goose rejects the empty raw draft CWD. Model routing must preserve
        // the absolute directory resolved by the send's initial preparation.
        if (cwd !== preparedCwd)
          throw new Error("cwd must be an absolute path");
        return {
          model: { modelId: "chosen", modelName: "Chosen" },
          reasoningEffort: null,
        };
      },
    );
    const lease = acquireSessionDispatchTarget("s");
    if (lease.status !== "acquired") throw new Error("Expected lease");
    try {
      const result = await prepareAutoRoutedPrompt("s", {
        text: "Task",
        dispatchToken: lease.token,
      });
      expect(result?.modelId).toBe("chosen");
      expect(acpPrepareSession).toHaveBeenCalledWith(
        "s",
        "openai",
        preparedCwd,
        expect.objectContaining({ modelId: "chosen" }),
      );
      expect(
        useChatSessionStore.getState().getSession("s")?.autoRoutingDecision
          ?.modelId,
      ).toBe("chosen");
    } finally {
      lease.release();
    }
  });

  it("skips the router after an explicit model choice", async () => {
    useChatSessionStore.getState().patchSession("s", { autoModeId: null });
    await prepareAutoRoutedPrompt("s", { text: "Task" });
    expect(routeAutoModel).not.toHaveBeenCalled();
    expect(acpPrepareSession).not.toHaveBeenCalled();
  });

  it("ignores a late routing response after manual opt-out", async () => {
    vi.mocked(routeAutoModel).mockImplementation(async () => {
      useChatSessionStore.getState().patchSession("s", { autoModeId: null });
      return { ...decision };
    });
    await expect(
      prepareAutoRoutedPrompt("s", { text: "Task" }),
    ).rejects.toThrow(PreCommitSendRejectedError);
    expect(acpPrepareSession).not.toHaveBeenCalled();
  });

  it("does not switch models when the prompt is cancelled during routing", async () => {
    const controller = new AbortController();
    vi.mocked(routeAutoModel).mockImplementation(async () => {
      controller.abort();
      return { ...decision };
    });
    await expect(
      prepareAutoRoutedPrompt("s", { text: "Task", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(acpPrepareSession).not.toHaveBeenCalled();
  });
});
