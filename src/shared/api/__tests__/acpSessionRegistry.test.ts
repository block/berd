import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpReasoningEffortConfigSnapshot,
  AcpSessionConfigSnapshots,
} from "../acpSessionConfigSnapshots";

const mockSetModel = vi.fn();
const mockSetProvider = vi.fn();
const mockSetSessionConfigOption = vi.fn();
const mockUpdateWorkingDir = vi.fn();
const mockLoadSession = vi.fn();
const mockInvalidateClientConnection = vi.fn();
const noRequestProviderContext = { requestId: undefined };
const noRequestModelContext = (providerId: string) => ({
  providerId,
  requestId: undefined,
});

vi.mock("../acpConnection", () => ({
  getBackendClient: vi.fn(),
  invalidateBackendConnection: (...args: unknown[]) =>
    mockInvalidateClientConnection(...args),
}));

vi.mock("../acpApi", () => ({
  setModel: (...args: unknown[]) => mockSetModel(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  setSessionConfigOption: (...args: unknown[]) =>
    mockSetSessionConfigOption(...args),
  updateWorkingDir: (...args: unknown[]) => mockUpdateWorkingDir(...args),
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
}));

async function importRegistry() {
  return import("../acpSessionRegistry");
}

async function importPreparedRegistry(
  providerId = "codex-acp",
  modelId: string | undefined = "default-model",
) {
  const registry = await importRegistry();
  registry.registerPreparedSession(
    "session-1",
    providerId,
    "/project",
    modelId,
  );
  return registry;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function executionConfigResponse(providerId: string, modelId: string) {
  return {
    configOptions: [
      {
        id: "provider",
        kind: { type: "select", currentValue: providerId, options: [] },
      },
      {
        id: "model",
        category: "model",
        kind: { type: "select", currentValue: modelId, options: [] },
      },
    ],
  };
}

function modelConfigResponse(
  modelId: string,
  modelName: string,
  reasoningEffort: AcpReasoningEffortConfigSnapshot | null = null,
): AcpSessionConfigSnapshots {
  return { model: { modelId, modelName }, reasoningEffort };
}

describe("applySessionModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSetModel.mockResolvedValue(undefined);
    mockSetProvider.mockResolvedValue(undefined);
    mockSetSessionConfigOption.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockLoadSession.mockResolvedValue(undefined);
    mockInvalidateClientConnection.mockResolvedValue(undefined);
  });

  it("sends setModel over the wire and records it for the session", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "  gpt-5.5  ");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "gpt-5.5",
      noRequestModelContext("codex-acp"),
    );
  });

  it("skips the wire call when the same model is re-applied", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  it("sends setModel again when the model actually changes", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.4");

    expect(mockSetModel).toHaveBeenCalledTimes(2);
    expect(mockSetModel).toHaveBeenLastCalledWith(
      "session-1",
      "gpt-5.4",
      noRequestModelContext("codex-acp"),
    );
  });

  it("retries over the wire after a failed setModel", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");

    mockSetModel.mockRejectedValueOnce(new Error("backend rejected model"));
    await expect(
      registry.applySessionModel("session-1", "gpt-5.4"),
    ).rejects.toThrow("backend rejected model");

    // The failure cleared the cached model, so re-applying the previously
    // successful model must go back over the wire instead of being skipped.
    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(3);
    expect(mockSetModel).toHaveBeenLastCalledWith(
      "session-1",
      "gpt-5.5",
      noRequestModelContext("codex-acp"),
    );
  });

  it("clears the cached model when the provider changes", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(1);

    // Provider change rebuilds the backend provider with its default model,
    // so the cached model id no longer reflects backend state.
    await registry.prepareSession("session-1", "claude-acp", "/project");
    expect(mockSetProvider).toHaveBeenCalledWith(
      "session-1",
      "claude-acp",
      noRequestProviderContext,
    );

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached model across a no-op prepareSession reuse", async () => {
    const registry = await importPreparedRegistry();

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.prepareSession("session-1", "codex-acp", "/project");
    await registry.applySessionModel("session-1", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetProvider).not.toHaveBeenCalled();
  });

  it("rejects model changes when the provider was never prepared", async () => {
    const registry = await importRegistry();

    await expect(
      registry.applySessionModel("session-unprepared", "gpt-5.5"),
    ).rejects.toThrow("Session not prepared");

    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("records the complete provider response selection atomically", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetProvider.mockResolvedValueOnce(
      modelConfigResponse("claude-fable", "Claude Fable"),
    );

    await registry.prepareSession("session-1", "anthropic", "/project");
    await registry.applySessionModel("session-1", "claude-fable");

    expect(mockSetProvider).toHaveBeenCalledWith(
      "session-1",
      "anthropic",
      noRequestProviderContext,
    );
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("serializes a newer provider selection behind an in-flight load", async () => {
    const registry = await importPreparedRegistry("anthropic", "claude-fable");
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);

    const load = registry.loadSession("session-1", "/project");
    const configure = registry.configureSession(
      "session-1",
      "anthropic",
      "/project",
      "claude-fable",
    );

    await vi.waitFor(() => expect(mockLoadSession).toHaveBeenCalledTimes(1));
    expect(mockSetProvider).not.toHaveBeenCalled();

    loadResponse.resolve(executionConfigResponse("openai", "gpt-4.1"));
    await expect(load).resolves.toMatchObject({ isCurrent: false });
    await configure;

    expect(registry.getPreparedProviderId("session-1")).toBe("anthropic");
    expect(mockSetProvider).toHaveBeenCalledWith(
      "session-1",
      "anthropic",
      noRequestProviderContext,
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "claude-fable",
      noRequestModelContext("anthropic"),
    );
  });

  it("serializes a model switch behind an in-flight config option", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-5.5");
    const configResponse = deferred<AcpSessionConfigSnapshots>();
    mockSetSessionConfigOption.mockReturnValueOnce(configResponse.promise);

    const reasoning = registry.applySessionConfigOption(
      "session-1",
      "thinking_effort",
      "high",
      {
        providerId: "openai",
        modelId: "gpt-5.5",
        reasoningEffortValue: "high",
      },
    );
    const model = registry.applySessionModel("session-1", "gpt-5.6");

    await vi.waitFor(() =>
      expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(1),
    );
    expect(mockSetModel).not.toHaveBeenCalled();

    configResponse.resolve(modelConfigResponse("gpt-5.5", "GPT-5.5"));
    await reasoning;
    await model;

    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
  });

  it("blocks prompting when preparation has no acknowledged model", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");
    const prompt = vi.fn().mockResolvedValue("complete");

    await expect(
      registry.runPreparedSessionPrompt("session-1", prompt),
    ).rejects.toThrow("configured provider and model");

    expect(registry.isSessionPrepared("session-1")).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("admits prompting after provider preparation acknowledges a model", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "openai", "/project");
    mockSetProvider.mockResolvedValueOnce(
      modelConfigResponse("gpt-5.5", "GPT-5.5"),
    );
    const prompt = vi.fn().mockResolvedValue("complete");

    await registry.prepareSession("session-1", "anthropic", "/project");

    await expect(
      registry.runPreparedSessionPrompt("session-1", prompt),
    ).resolves.toBe("complete");
    expect(registry.isSessionPrepared("session-1")).toBe(true);
    expect(prompt).toHaveBeenCalledWith("anthropic");
  });

  it("does not time out a long-running prompt or admit config work mid-turn", async () => {
    vi.useFakeTimers();
    try {
      const registry = await importPreparedRegistry("openai", "gpt-5.5");
      const promptResponse = deferred<string>();
      let promptSettled = false;

      const prompt = registry
        .runPreparedSessionPrompt("session-1", () => promptResponse.promise)
        .finally(() => {
          promptSettled = true;
        });
      const model = registry.applySessionModel("session-1", "gpt-5.6");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(promptSettled).toBe(false);
      expect(mockInvalidateClientConnection).not.toHaveBeenCalled();
      expect(mockSetModel).not.toHaveBeenCalled();

      promptResponse.resolve("complete");
      await expect(prompt).resolves.toBe("complete");
      await expect(model).resolves.toBeUndefined();
      expect(mockSetModel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stuck mutation, invalidates ACP, and admits queued work", async () => {
    vi.useFakeTimers();
    try {
      const registry = await importPreparedRegistry("openai", "gpt-5.5");
      const stuck = deferred<AcpSessionConfigSnapshots>();
      mockSetSessionConfigOption.mockReturnValueOnce(stuck.promise);
      mockLoadSession.mockResolvedValueOnce(
        executionConfigResponse("openai", "gpt-5.5"),
      );

      const reasoning = registry.applySessionConfigOption(
        "session-1",
        "thinking_effort",
        "high",
      );
      const load = registry.loadSession("session-1", "/project");

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(reasoning).rejects.toThrow("ACP operation timed out");
      await expect(load).resolves.toMatchObject({ isCurrent: true });
      expect(mockInvalidateClientConnection).toHaveBeenCalledOnce();
      expect(mockInvalidateClientConnection).toHaveBeenCalledWith("local");
      expect(mockLoadSession).toHaveBeenCalledOnce();
      expect(registry.getPreparedProviderId("session-1")).toBe("openai");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a superseded load pair for the queued model mutation", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);

    const load = registry.loadSession("session-1", "/project");
    const apply = registry.applySessionModel("session-1", "gpt-5.6");
    loadResponse.resolve(executionConfigResponse("openai", "gpt-5.5"));

    await expect(load).resolves.toMatchObject({ isCurrent: false });
    await expect(apply).resolves.toBeUndefined();

    expect(mockSetModel).toHaveBeenCalledWith(
      "session-1",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
  });

  it("does not run a load between one provider and model configuration", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    const providerResponse = deferred<AcpSessionConfigSnapshots>();
    const modelResponse = deferred<AcpSessionConfigSnapshots>();
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockSetProvider.mockReturnValueOnce(providerResponse.promise);
    mockSetModel.mockReturnValueOnce(modelResponse.promise);
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);

    const configure = registry.configureSession(
      "session-1",
      "anthropic",
      "/project",
      "claude-fable",
    );
    const load = registry.loadSession("session-1", "/project");

    await vi.waitFor(() => expect(mockSetProvider).toHaveBeenCalledTimes(1));
    expect(mockSetModel).not.toHaveBeenCalled();
    expect(mockLoadSession).not.toHaveBeenCalled();

    providerResponse.resolve(
      modelConfigResponse("claude-sonnet", "Claude Sonnet"),
    );
    await vi.waitFor(() => expect(mockSetModel).toHaveBeenCalledTimes(1));
    expect(mockLoadSession).not.toHaveBeenCalled();

    modelResponse.resolve(modelConfigResponse("claude-fable", "Claude Fable"));
    await configure;
    await vi.waitFor(() => expect(mockLoadSession).toHaveBeenCalledTimes(1));

    loadResponse.resolve(executionConfigResponse("anthropic", "claude-fable"));
    await expect(load).resolves.toMatchObject({ isCurrent: true });
    await registry.applySessionModel("session-1", "claude-fable");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  it("returns the final model snapshot without provider-default fields", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-5.5");
    mockSetProvider.mockResolvedValueOnce(
      modelConfigResponse("claude-sonnet", "Claude Sonnet", {
        configId: "thinking_effort",
        currentValue: "high",
        options: [{ id: "high", name: "High" }],
      }),
    );
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("claude-fable", "Claude Fable"),
    );

    await expect(
      registry.configureSession(
        "session-1",
        "anthropic",
        "/project",
        "claude-fable",
      ),
    ).resolves.toEqual({
      model: { modelId: "claude-fable", modelName: "Claude Fable" },
      reasoningEffort: null,
    });
  });

  it("invalidates the acknowledged pair when provider setup fails", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetProvider.mockRejectedValueOnce(new Error("snapshot failed"));

    await expect(
      registry.prepareSession("session-1", "anthropic", "/project"),
    ).rejects.toThrow("snapshot failed");

    expect(registry.isSessionPrepared("session-1")).toBe(false);
    await registry.prepareSession("session-1", "openai", "/project");
    expect(mockSetProvider).toHaveBeenLastCalledWith(
      "session-1",
      "openai",
      noRequestProviderContext,
    );
  });

  it("rejects a model response that acknowledges a different model", async () => {
    const registry = await importPreparedRegistry("openai", "gpt-4.1");
    mockSetModel.mockResolvedValueOnce(
      modelConfigResponse("gpt-5.5", "GPT-5.5"),
    );

    await expect(
      registry.applySessionModel("session-1", "gpt-5.6"),
    ).rejects.toThrow(
      "ACP acknowledged model gpt-5.5 instead of requested model gpt-5.6",
    );

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(1);
    await registry.applySessionModel("session-1", "gpt-5.6");
    expect(mockSetModel).toHaveBeenCalledTimes(2);
  });
});
