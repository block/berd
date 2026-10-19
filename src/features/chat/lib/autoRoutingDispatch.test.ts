import { PreCommitSendRejectedError } from "./preCommitSendRejection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acpGetPreparedWorkingDir,
  acpSendMessage,
  acpPrepareSession,
  acpSetSessionConfigOption,
} from "@/shared/api/acp";
import { repairManagedGooseModelSelection } from "@/features/providers/lib/managedModelSelectionRepair";
import { invokeWithStartupRetry } from "@/shared/api/invokeWithStartupRetry";
import { routeAutoModel } from "@/shared/api/autoRouting";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import { prepareAutoRoutedPrompt } from "./autoRoutingDispatch";
import { dispatchPrompt } from "./sendCore";
import { acpSessionToChatSession } from "./acpSessionMapping";
import { loadAutoMode, persistAutoMode } from "../stores/autoModePersistence";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
} from "./sessionTargetCoordinator";

vi.mock("@/shared/api/invokeWithStartupRetry", () => ({
  invokeWithStartupRetry: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetPreparedWorkingDir: vi.fn(),
  acpSendMessage: vi.fn(),
  acpExportSession: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSetSessionConfigOption: vi.fn(),
}));
vi.mock("@/shared/api/autoRouting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/autoRouting")>()),
  routeAutoModel: vi.fn(),
}));
vi.mock("@/features/providers/lib/managedModelSelectionRepair", () => ({
  repairManagedGooseModelSelection: vi.fn(),
}));

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
    localStorage.removeItem("goose:chat-auto-modes");
    vi.mocked(acpSendMessage).mockImplementation(
      async (_sessionId, _prompt, options) => {
        options?.onPromptDispatching?.();
      },
    );
    vi.mocked(repairManagedGooseModelSelection).mockResolvedValue(null);
    vi.mocked(acpGetPreparedWorkingDir).mockReturnValue("/work");
    resetSessionTargetCoordinatorsForTests();
    useRuntimeConfigStore.setState({
      loaded: true,
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

  function configureDistinctFallback() {
    const config = useRuntimeConfigStore.getState().config;
    const mode = config.goose.autoRouting?.modes[0];
    if (!mode) throw new Error("Expected mode");
    const autoRouting = config.goose.autoRouting;
    if (!autoRouting) throw new Error("Expected routing config");
    useRuntimeConfigStore.setState({
      config: {
        ...config,
        goose: {
          ...config.goose,
          autoRouting: {
            ...autoRouting,
            modes: [
              {
                ...mode,
                fallback: { modelId: "fallback", effort: "high" },
                models: [
                  ...mode.models,
                  {
                    modelId: "fallback",
                    routerModel: "router-fallback",
                    minEffort: "high",
                  },
                ],
              },
            ],
          },
        },
      },
    });
    vi.mocked(acpPrepareSession).mockImplementation(
      async (_id, _provider, _cwd, options) => ({
        model: {
          modelId: options?.modelId ?? "",
          modelName: options?.modelId ?? "",
        },
        reasoningEffort: null,
      }),
    );
  }
  it("retries the configured fallback once after inventory substitutes the routed model", async () => {
    configureDistinctFallback();
    vi.mocked(repairManagedGooseModelSelection).mockImplementation(
      async (selection) =>
        selection.modelId === "chosen"
          ? {
              providerId: selection.providerId ?? "openai",
              modelId: "substitute",
            }
          : null,
    );
    const lease = acquireSessionDispatchTarget("s");
    if (lease.status !== "acquired") throw new Error("Expected lease");
    try {
      const result = await prepareAutoRoutedPrompt("s", {
        text: "Task",
        dispatchToken: lease.token,
      });
      expect(result).toMatchObject({
        modelId: "fallback",
        source: "fallback",
        fallbackReason: "model_unavailable",
        response: decision.response,
      });
      expect(acpPrepareSession).toHaveBeenCalledTimes(1);
      expect(
        useChatSessionStore.getState().getSession("s")?.executionTarget
          ?.modelId,
      ).toBe("fallback");
    } finally {
      lease.release();
    }
  });
  it("retries the configured fallback after routed model activation fails", async () => {
    configureDistinctFallback();
    vi.mocked(acpPrepareSession).mockRejectedValueOnce(
      new Error("Model no longer served"),
    );
    const result = await prepareAutoRoutedPrompt("s", { text: "Task" });
    expect(result).toMatchObject({ modelId: "fallback", source: "fallback" });
    expect(acpPrepareSession).toHaveBeenCalledTimes(2);
  });
  it("stops after the configured fallback is also unavailable without recording a substitute", async () => {
    configureDistinctFallback();
    vi.mocked(repairManagedGooseModelSelection).mockImplementation(
      async (selection) => ({
        providerId: selection.providerId ?? "openai",
        modelId: "substitute",
      }),
    );
    await expect(
      prepareAutoRoutedPrompt("s", { text: "Task" }),
    ).rejects.toThrow();
    expect(acpPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget?.modelId,
    ).toBe("previous");
    expect(
      useChatSessionStore.getState().getSession("s")?.autoRoutingDecision,
    ).toBeUndefined();
  });

  it.each([
    "renamed",
    "disabled",
  ])("sends a restored chat on its concrete target when Auto is %s", async (change) => {
    persistAutoMode("s", "balanced");
    const backendSession = {
      sessionId: "s",
      title: "Restored chat",
      providerId: "openai",
      modelId: "previous",
      workingDir: "/work",
      messageCount: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      lastMessageAt: null,
      archivedAt: null,
      userSetName: false,
      subtitle: null,
      personaId: null,
    };
    const restored = acpSessionToChatSession(backendSession);
    expect(restored.autoModeId).toBe("balanced");
    useChatSessionStore.setState({
      sessions: [{ ...restored, autoRoutingDecision: { ...decision } }],
    });
    const config = useRuntimeConfigStore.getState().config;
    useRuntimeConfigStore.setState({
      config: {
        ...config,
        goose: {
          ...config.goose,
          autoRouting:
            change === "disabled"
              ? undefined
              : {
                  ...config.goose.autoRouting!,
                  modes: config.goose.autoRouting!.modes.map((mode) => ({
                    ...mode,
                    id: "replacement",
                  })),
                },
        },
      },
    });
    const target = useChatSessionStore
      .getState()
      .getSession("s")?.executionTarget;
    const lease = acquireSessionDispatchTarget("s");
    if (lease.status !== "acquired") throw new Error("Expected lease");
    try {
      await dispatchPrompt("s", "Continue my chat", {
        providerId: "openai",
        dispatchToken: lease.token,
      });
    } finally {
      lease.release();
    }
    expect(routeAutoModel).not.toHaveBeenCalled();
    expect(acpPrepareSession).not.toHaveBeenCalled();
    expect(acpSetSessionConfigOption).not.toHaveBeenCalled();
    expect(acpSendMessage).toHaveBeenCalledOnce();
    expect(useChatSessionStore.getState().getSession("s")).toMatchObject({
      executionTarget: target,
      autoModeId: null,
    });
    expect(
      useChatSessionStore.getState().getSession("s")?.autoRoutingDecision,
    ).toBeUndefined();
    expect(loadAutoMode("s")).toBeNull();
    expect(
      useChatStore
        .getState()
        .messagesBySession.s.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(
      acpSessionToChatSession({ ...backendSession, messageCount: 1 })
        .autoModeId,
    ).toBeNull();
  });

  it("retains Auto intent while runtime configuration is still loading", async () => {
    useRuntimeConfigStore.setState({
      loaded: false,
      config: DEFAULT_RUNTIME_CONFIG,
    });
    await expect(
      prepareAutoRoutedPrompt("s", { text: "Task" }),
    ).rejects.toThrow(PreCommitSendRejectedError);
    expect(useChatSessionStore.getState().getSession("s")?.autoModeId).toBe(
      "balanced",
    );
    expect(routeAutoModel).not.toHaveBeenCalled();
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

  it("releases the owning dispatch lease on Stop while native routing stays pending", async () => {
    const actual = await vi.importActual<
      typeof import("@/shared/api/autoRouting")
    >("@/shared/api/autoRouting");
    vi.mocked(routeAutoModel).mockImplementation(actual.routeAutoModel);
    let finish!: (value: unknown) => void;
    vi.mocked(invokeWithStartupRetry).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const lease = acquireSessionDispatchTarget("s");
    if (lease.status !== "acquired") throw new Error("Expected lease");
    const pending = prepareAutoRoutedPrompt("s", {
      text: "Task",
      signal: controller.signal,
      dispatchToken: lease.token,
    }).finally(lease.release);
    await vi.waitFor(() =>
      expect(invokeWithStartupRetry).toHaveBeenCalledTimes(1),
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    const next = acquireSessionDispatchTarget("s");
    expect(next.status).toBe("acquired");
    if (next.status === "acquired") next.release();
    finish({
      route_selection: [
        { route_option: { model: "chosen", harness: "codex" } },
      ],
    });
    await Promise.resolve();
    expect(acpPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("s")?.autoRoutingDecision,
    ).toBeUndefined();
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
