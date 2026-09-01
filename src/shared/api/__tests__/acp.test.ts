import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";

import {
  DEFAULT_STYLE_GUIDELINES_PROMPT,
  STYLE_GUIDELINES_STORAGE_KEY,
} from "@/shared/preferences/styleGuidelinesPreference";
import { INTERACTION_NORMS_PREAMBLE } from "@/shared/api/interactionNorms";

const mockLoadSession = vi.fn();
const mockNewSession = vi.fn();
const mockSetProvider = vi.fn();
const mockSetModel = vi.fn();
const mockPrompt = vi.fn();
const mockSteerSession = vi.fn();
const mockAppendSessionSystemPrompt = vi.fn();
const mockForkSession = vi.fn();
const mockRenameSession = vi.fn();
const mockArchiveSession = vi.fn();
const noRequestProviderContext = { requestId: undefined };
const noRequestModelContext = (providerId: string) => ({
  providerId,
  requestId: undefined,
});

const managedRuntimeConfig: RuntimeConfig = {
  schemaVersion: 1,
  goose: {
    defaultModelProviderId: "databricks_v2",
    defaultModelId: "goose-gpt-5-5",
    modelProviders: [
      {
        id: "databricks_v2",
        displayName: "Databricks v2",
        models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
      },
      {
        id: "other-managed",
        displayName: "Other managed",
        models: [{ id: "other-model", name: "Other" }],
      },
    ],
  },
};

async function setRuntimeConfig(config: RuntimeConfig) {
  const { useRuntimeConfigStore } = await import(
    "@/shared/runtime-config/runtimeConfigStore"
  );
  useRuntimeConfigStore.setState({
    loaded: true,
    result: { status: "ready", source: "appDefault", config },
    config,
  });
}

const GOOSE_MANAGED_PROVIDER_IDS = ["goose", "databricks_v2"] as const;
const EXTERNAL_AGENT_PROVIDER_IDS = ["claude-acp", "codex-acp"] as const;
const reasoningEffortSnapshot = {
  configId: "thinking_effort",
  currentValue: "high",
  options: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
  ],
};

function setStyleGuidelinesPreference(prompt: string) {
  localStorage.setItem(
    STYLE_GUIDELINES_STORAGE_KEY,
    JSON.stringify({ prompt }),
  );
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

vi.mock("../acpApi", () => ({
  listProviders: vi.fn(),
  prompt: (...args: unknown[]) => {
    const result = mockPrompt(...args);
    const callbacks = args[3] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    callbacks?.onPromptDispatching?.();
    callbacks?.onPromptDispatched?.();
    return result;
  },
  appendSessionSystemPrompt: (...args: unknown[]) =>
    mockAppendSessionSystemPrompt(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  steerSession: (...args: unknown[]) => mockSteerSession(...args),
  listSessions: vi.fn(),
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  newSession: (...args: unknown[]) => mockNewSession(...args),
  exportSession: vi.fn(),
  importSession: vi.fn(),
  forkSession: (...args: unknown[]) => mockForkSession(...args),
  renameSession: (...args: unknown[]) => mockRenameSession(...args),
  archiveSession: (...args: unknown[]) => mockArchiveSession(...args),
  cancelSession: vi.fn(),
}));

const mockGetBerdctlPreamble = vi.fn<
  () => string | null | Promise<string | null>
>(() => null);

vi.mock("@/features/berdctl/appPreamble", () => ({
  getBerdctlPreamble: () => mockGetBerdctlPreamble(),
}));

vi.mock("../acpActiveMessageTracking", () => ({
  setActiveMessageId: vi.fn(),
  clearActiveMessageId: vi.fn(),
}));

vi.mock("../sessionSearch", () => ({
  searchSessions: vi.fn(),
}));

describe("acpSteerMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("blocks transport when the prepared session has no acknowledged model", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSteerMessage } = await import("../acp");
    sessionRegistry.registerPreparedSession(
      "acp-session-steer-missing-model",
      "goose",
      "/tmp/project",
    );

    await expect(
      acpSteerMessage("acp-session-steer-missing-model", "run-1", "more"),
    ).rejects.toThrow("configured provider and model");

    expect(mockSteerSession).not.toHaveBeenCalled();
  });
});

describe("acpSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // clearAllMocks clears call history but not return values; reset the
    // preamble to unavailable so tests opt in explicitly.
    mockGetBerdctlPreamble.mockReturnValue(null);
    localStorage.removeItem(STYLE_GUIDELINES_STORAGE_KEY);
  });

  it("blocks transport when the prepared session has no acknowledged model", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    sessionRegistry.registerPreparedSession(
      "acp-session-missing-model",
      "goose",
      "/tmp/project",
    );

    await expect(
      acpSendMessage("acp-session-missing-model", "hello"),
    ).rejects.toThrow("configured provider and model");

    expect(mockAppendSessionSystemPrompt).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("reports dispatch only after ACP setup reaches the transport boundary", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    const onPromptDispatched = vi.fn();
    sessionRegistry.registerPreparedSession(
      "acp-session-dispatch-boundary",
      "goose",
      "/tmp/project",
      "test-model",
    );
    mockAppendSessionSystemPrompt.mockRejectedValueOnce(
      new Error("ACP setup failed"),
    );

    await expect(
      acpSendMessage("acp-session-dispatch-boundary", "hello", {
        onPromptDispatched,
      }),
    ).rejects.toThrow("ACP setup failed");

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(onPromptDispatched).not.toHaveBeenCalled();
  });

  it("reports dispatch immediately after invoking the external prompt", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    const onPromptDispatched = vi.fn();
    let resolvePrompt!: () => void;
    mockPrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      }),
    );
    sessionRegistry.registerPreparedSession(
      "acp-session-dispatched",
      "goose",
      "/tmp/project",
      "test-model",
    );

    const send = acpSendMessage("acp-session-dispatched", "hello", {
      onPromptDispatched,
    });
    await vi.waitFor(() => expect(onPromptDispatched).toHaveBeenCalledOnce());
    expect(mockPrompt).toHaveBeenCalledOnce();

    resolvePrompt();
    await send;
  });

  it.each(
    GOOSE_MANAGED_PROVIDER_IDS,
  )("adds configured style guidelines before sending for %s", async (providerId) => {
    const configuredPrompt = "Use concise, test-specific style guidance.";
    setStyleGuidelinesPreference(configuredPrompt);

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    const sessionId = `acp-session-${providerId}`;

    sessionRegistry.registerPreparedSession(
      sessionId,
      providerId,
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage(sessionId, "hello", {
      systemPrompt: "You are Starfriend.",
    });

    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      1,
      sessionId,
      "goose_internal_style_guidelines",
      "",
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      2,
      sessionId,
      "berd_style_guidelines",
      configuredPrompt,
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      3,
      sessionId,
      "berd_interaction_norms",
      INTERACTION_NORMS_PREAMBLE,
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      4,
      sessionId,
      "berd_app_context",
      "",
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      5,
      sessionId,
      "client_system_prompt",
      "You are Starfriend.",
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenCalledTimes(5);
  });

  it("adds the default style guidelines when unset", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-default-style",
      "goose",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-default-style", "hello", {
      systemPrompt: "You are Starfriend.",
    });

    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      1,
      "acp-session-default-style",
      "goose_internal_style_guidelines",
      "",
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      2,
      "acp-session-default-style",
      "berd_style_guidelines",
      DEFAULT_STYLE_GUIDELINES_PROMPT,
    );
  });

  it("normalizes empty style guidelines to the default prompt", async () => {
    setStyleGuidelinesPreference("   ");

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-empty-style",
      "goose",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-empty-style", "hello", {
      systemPrompt: "You are Starfriend.",
    });

    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      2,
      "acp-session-empty-style",
      "berd_style_guidelines",
      DEFAULT_STYLE_GUIDELINES_PROMPT,
    );
  });

  it("sends the berdctl preamble under berd_app_context when available", async () => {
    mockGetBerdctlPreamble.mockReturnValue("[Berd]\nberdctl is on your PATH.");

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-preamble",
      "goose",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-preamble", "hello", {});

    expect(mockAppendSessionSystemPrompt).toHaveBeenCalledWith(
      "acp-session-preamble",
      "berd_app_context",
      "[Berd]\nberdctl is on your PATH.",
    );
  });

  it("hands the interaction norms off in-band for external agents, before the persona", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-norms-ext",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-norms-ext", "hello", {
      systemPrompt: "You are Starfriend.",
    });

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain(INTERACTION_NORMS_PREAMBLE);
    expect(blocks[0].text.indexOf(INTERACTION_NORMS_PREAMBLE)).toBeLessThan(
      blocks[0].text.indexOf("You are Starfriend."),
    );
  });

  it("hands the berdctl preamble off in-band for external agents, before the persona", async () => {
    mockGetBerdctlPreamble.mockReturnValue("[Berd]\nberdctl is on your PATH.");

    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-preamble-ext",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-preamble-ext", "hello", {
      systemPrompt: "You are Starfriend.",
    });

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("berdctl is on your PATH.");
    expect(blocks[0].text).toContain("You are Starfriend.");
    expect(blocks[0].text.indexOf("berdctl is on your PATH.")).toBeLessThan(
      blocks[0].text.indexOf("You are Starfriend."),
    );
  });

  it("hands the berdctl preamble off for external agents even without a persona", async () => {
    mockGetBerdctlPreamble.mockReturnValue("[Berd]\nberdctl is on your PATH.");

    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-preamble-only",
      "codex-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-preamble-only", "hello", {});

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("berdctl is on your PATH.");
  });

  it.each(
    EXTERNAL_AGENT_PROVIDER_IDS,
  )("hands the persona off in-band on the first prompt for %s", async (providerId) => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      `acp-session-${providerId}`,
      providerId,
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage(`acp-session-${providerId}`, "hello", {
      systemPrompt: "You are Starfriend.",
    });

    // External agents ignore the goose system-prompt ext method, so we must
    // not call it for them.
    expect(mockAppendSessionSystemPrompt).not.toHaveBeenCalled();

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("You are Starfriend.");
    expect(blocks[blocks.length - 1]).toEqual({
      type: "text",
      text: "hello",
    });
  });

  it("does not consume an external persona handoff when ownership fails", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();
    sessionRegistry.registerPreparedSession(
      "acp-session-canceled-handoff",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );
    mockPrompt.mockImplementationOnce(
      (
        _sessionId: string,
        _content: unknown,
        _meta: unknown,
        callbacks?: { onPromptDispatching?: () => void },
      ) => {
        callbacks?.onPromptDispatching?.();
        return Promise.resolve();
      },
    );

    await expect(
      acpSendMessage("acp-session-canceled-handoff", "canceled", {
        systemPrompt: "You are Starfriend.",
        onPromptDispatching: () => {
          throw new DOMException("canceled", "AbortError");
        },
      }),
    ).rejects.toThrow("canceled");
    await acpSendMessage("acp-session-canceled-handoff", "retry", {
      systemPrompt: "You are Starfriend.",
    });

    const [, retryBlocks] = mockPrompt.mock.calls[1];
    expect(retryBlocks[0].text).toContain("You are Starfriend.");
  });

  it("merges the persona handoff with a skill assistant prompt, persona first", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-codex",
      "codex-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-codex", "hello", {
      systemPrompt: "You are Starfriend.",
      assistantPrompt: "Use these skills for this request: goose-help.",
    });

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("You are Starfriend.");
    expect(blocks[0].text).toContain(
      "Use these skills for this request: goose-help.",
    );
    expect(blocks[0].text.indexOf("You are Starfriend.")).toBeLessThan(
      blocks[0].text.indexOf("Use these skills"),
    );
  });

  it("only hands the persona off once per agent, but re-injects after an agent switch", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-switch",
      "claude-acp",
      "/tmp/project",
      "test-model",
    );

    await acpSendMessage("acp-session-switch", "first", {
      systemPrompt: "You are Starfriend.",
    });
    await acpSendMessage("acp-session-switch", "second", {
      systemPrompt: "You are Starfriend.",
    });

    // First send injects the handoff, second does not.
    expect(mockPrompt.mock.calls[0][1][0].text).toContain(
      "You are Starfriend.",
    );
    expect(mockPrompt.mock.calls[1][1][0]).toEqual({
      type: "text",
      text: "second",
    });

    // Switching the session to a different agent re-triggers the handoff.
    sessionRegistry.registerPreparedSession(
      "acp-session-switch",
      "codex-acp",
      "/tmp/project",
      "test-model",
    );
    await acpSendMessage("acp-session-switch", "third", {
      systemPrompt: "You are Starfriend.",
    });
    expect(mockPrompt.mock.calls[2][1][0].text).toContain(
      "You are Starfriend.",
    );
  });

  it("does not apply model config after prompt admission until the prompt finishes", async () => {
    const promptSetup = deferred<string | null>();
    const promptResponse = deferred<void>();
    mockGetBerdctlPreamble.mockReturnValueOnce(promptSetup.promise);
    mockPrompt.mockReturnValueOnce(promptResponse.promise);
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");
    const sessionId = "acp-session-prompt-config-race";
    sessionRegistry.registerPreparedSession(
      sessionId,
      "codex-acp",
      "/tmp/project",
      "gpt-5.5",
    );

    const send = acpSendMessage(sessionId, "hello");
    await vi.waitFor(() => expect(mockGetBerdctlPreamble).toHaveBeenCalled());
    const setModel = sessionRegistry.applySessionModel(sessionId, "gpt-5.6");
    await Promise.resolve();

    expect(mockSetModel).not.toHaveBeenCalled();

    promptSetup.resolve(null);
    await vi.waitFor(() => expect(mockPrompt).toHaveBeenCalled());
    expect(mockSetModel).not.toHaveBeenCalled();

    promptResponse.resolve(undefined);
    await send;
    await setModel;

    expect(mockPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetModel.mock.invocationCallOrder[0],
    );
  });
});

describe("acpLoadSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("restores the prior prepared session registration when replay loading fails", async () => {
    mockLoadSession.mockRejectedValueOnce(new Error("load failed"));

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-1",
      "goose",
      "/tmp/original",
      "gpt-5.6",
    );

    await expect(
      acpLoadSession("acp-session-1", "/tmp/replay"),
    ).rejects.toThrow("load failed");

    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
    await sessionRegistry.applySessionModel("acp-session-1", "gpt-5.6");
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("registers the provider and model acknowledged by session load", async () => {
    mockLoadSession.mockResolvedValueOnce(
      executionConfigResponse("databricks_v2", "goose-gpt-5-6-sol"),
    );
    const { acpLoadSession, acpPrepareSession } = await import("../acp");

    await acpLoadSession("acp-session-1", "/tmp/replay");
    await acpPrepareSession("acp-session-1", "databricks_v2", "/tmp/replay", {
      modelId: "goose-gpt-5-6-sol",
    });

    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(mockSetProvider).not.toHaveBeenCalled();
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("does not replay a loaded session when its execution selection is unknown", async () => {
    mockLoadSession.mockResolvedValueOnce({ configOptions: [] });
    const { acpLoadSession, acpPrepareSession } = await import("../acp");

    await acpLoadSession("acp-session-1", "/tmp/replay");
    await acpPrepareSession("acp-session-1", "openai", "/tmp/replay", {
      modelId: "gpt-5.6",
    });

    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(mockSetProvider).toHaveBeenCalledWith(
      "acp-session-1",
      "openai",
      noRequestProviderContext,
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-1",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
  });

  it("hydrates reasoning effort from the load response config options", async () => {
    mockLoadSession.mockResolvedValueOnce({
      configOptions: [
        {
          id: "thinking_effort",
          category: "thought_level",
          kind: {
            type: "select",
            currentValue: "medium",
            options: {
              type: "ungrouped",
              values: [
                { value: "off", name: "off" },
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          },
        },
      ],
    });
    const applyReasoningEffortConfigSnapshot = vi.fn();

    const { setSessionConfigSnapshotHandlers } = await import(
      "../acpSessionConfigSnapshots"
    );
    setSessionConfigSnapshotHandlers({
      applyReasoningEffortConfigSnapshot,
    });
    const { acpLoadSession } = await import("../acp");

    await acpLoadSession("acp-session-1", "/tmp/replay");

    expect(applyReasoningEffortConfigSnapshot).toHaveBeenCalledWith(
      "acp-session-1",
      {
        configId: "thinking_effort",
        currentValue: "medium",
        options: [
          { id: "off", name: "off" },
          { id: "low", name: "low" },
          { id: "medium", name: "medium" },
          { id: "high", name: "high" },
        ],
      },
      { origin: "response" },
    );
  });

  it("does not dispatch a load snapshot superseded by a UI configuration", async () => {
    const loadResponse = deferred<ReturnType<typeof executionConfigResponse>>();
    mockLoadSession.mockReturnValueOnce(loadResponse.promise);
    mockSetProvider.mockResolvedValueOnce(undefined);
    const applyModelConfigSnapshot = vi.fn();
    const { setSessionConfigSnapshotHandlers } = await import(
      "../acpSessionConfigSnapshots"
    );
    setSessionConfigSnapshotHandlers({ applyModelConfigSnapshot });
    const sessionRegistry = await import("../acpSessionRegistry");
    sessionRegistry.registerPreparedSession(
      "acp-session-race",
      "openai",
      "/tmp/replay",
      "gpt-5.6",
    );
    const { acpLoadSession, acpPrepareSession } = await import("../acp");

    const load = acpLoadSession("acp-session-race", "/tmp/replay");
    const configure = acpPrepareSession(
      "acp-session-race",
      "openai",
      "/tmp/replay",
      { modelId: "gpt-5.6" },
    );
    loadResponse.resolve(executionConfigResponse("openai", "gpt-5.5"));

    await load;
    await configure;

    expect(applyModelConfigSnapshot).not.toHaveBeenCalled();
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-race",
      "gpt-5.6",
      noRequestModelContext("openai"),
    );
  });
});

describe("acpCreateSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSetProvider.mockReset();
    mockSetProvider.mockResolvedValue({ model: null, reasoningEffort: null });
    mockSetModel.mockReset();
    mockSetModel.mockResolvedValue({ model: null, reasoningEffort: null });
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("uses the ACP session id as the UI session id", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("openai", "/tmp/project", {
        projectId: "project-1",
        personaId: "persona-1",
        modelId: "gpt-4.1",
      }),
    ).resolves.toEqual({
      sessionId: "acp-session-1",
      configOptionsSnapshot: {
        model: null,
        reasoningEffort: null,
      },
    });

    expect(mockNewSession).toHaveBeenCalledWith("/tmp/project", {
      providerId: "openai",
      projectId: "project-1",
      personaId: "persona-1",
    });
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSetProvider).toHaveBeenCalledWith("acp-session-1", "openai");
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-1",
      "gpt-4.1",
      noRequestModelContext("openai"),
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });

  it("routes creation to the host's SSH backend when remoteHost is set", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-remote" });

    const { acpCreateSession } = await import("../acp");

    await acpCreateSession("openai", "/home/dev/project", {
      modelId: "gpt-4.1",
      remoteHost: "devbox",
    });

    expect(mockNewSession).toHaveBeenCalledWith("/home/dev/project", {
      providerId: "openai",
      projectId: undefined,
      personaId: undefined,
      backendId: "ssh:devbox",
    });
  });

  it("does not send a backendId for local sessions", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-local" });

    const { acpCreateSession } = await import("../acp");

    await acpCreateSession("openai", "/tmp/project", { modelId: "gpt-4.1" });

    const [, newSessionOptions] = mockNewSession.mock.calls[0];
    expect(newSessionOptions).not.toHaveProperty("backendId");
  });

  it("sends a concrete provider even when provider setup is deferred", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await acpCreateSession("openai", "/tmp/project", {
      deferProviderSetup: true,
    });

    expect(mockNewSession).toHaveBeenCalledWith("/tmp/project", {
      providerId: "openai",
      projectId: undefined,
      personaId: undefined,
    });
    expect(mockSetProvider).toHaveBeenCalledWith("acp-session-1", "openai");
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });

  it("can defer goose provider setup until a model is selected", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("goose", "/tmp/project", {
        deferProviderSetup: true,
      }),
    ).resolves.toEqual({
      sessionId: "acp-session-1",
      configOptionsSnapshot: {
        model: null,
        reasoningEffort: null,
      },
    });

    expect(mockNewSession).toHaveBeenCalledWith("/tmp/project", {
      providerId: undefined,
      projectId: undefined,
      personaId: undefined,
    });
    expect(mockSetProvider).not.toHaveBeenCalled();
    expect(mockSetModel).not.toHaveBeenCalled();
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(false);
  });

  it("does not defer provider setup when a model is provided", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await acpCreateSession("anthropic", "/tmp/project", {
      modelId: "claude-sonnet-4",
      deferProviderSetup: true,
    });

    expect(mockNewSession).toHaveBeenCalledWith("/tmp/project", {
      providerId: "anthropic",
      projectId: undefined,
      personaId: undefined,
    });
    expect(mockSetProvider).toHaveBeenCalledWith("acp-session-1", "anthropic");
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-1",
      "claude-sonnet-4",
      noRequestModelContext("anthropic"),
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });

  it("activates a deferred session through load, provider setup, and model setup", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession, acpPrepareSession } = await import("../acp");

    const { sessionId } = await acpCreateSession("goose", "/tmp/project", {
      deferProviderSetup: true,
    });

    await acpPrepareSession(sessionId, "anthropic", "/tmp/project", {
      modelId: "claude-sonnet-4",
    });

    expect(mockLoadSession).toHaveBeenCalledWith(
      "acp-session-1",
      "/tmp/project",
    );
    expect(mockSetProvider).toHaveBeenCalledWith(
      "acp-session-1",
      "anthropic",
      noRequestProviderContext,
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-1",
      "claude-sonnet-4",
      noRequestModelContext("anthropic"),
    );
    expect(mockLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetProvider.mock.invocationCallOrder[0],
    );
    expect(mockSetProvider.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetModel.mock.invocationCallOrder[0],
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });

  it("archives a newly created session when eager provider setup fails", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "orphaned-session" });
    mockSetProvider.mockRejectedValueOnce(new Error("provider setup failed"));

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await expect(acpCreateSession("openai", "/tmp/project")).rejects.toThrow(
      "provider setup failed",
    );
    expect(mockArchiveSession).toHaveBeenCalledWith("orphaned-session");
    expect(sessionRegistry.isSessionPrepared("orphaned-session")).toBe(false);
  });

  it("archives and unregisters a newly created session when eager model setup fails", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "orphaned-session" });
    mockSetModel.mockRejectedValueOnce(new Error("model setup failed"));

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("openai", "/tmp/project", { modelId: "gpt-4.1" }),
    ).rejects.toThrow("model setup failed");
    expect(mockArchiveSession).toHaveBeenCalledWith("orphaned-session");
    expect(sessionRegistry.isSessionPrepared("orphaned-session")).toBe(false);
  });

  it("returns the latest config snapshot from session creation setup", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });
    mockSetProvider.mockResolvedValueOnce({
      model: null,
      reasoningEffort: null,
    });
    mockSetModel.mockResolvedValueOnce({
      model: {
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
      },
      reasoningEffort: reasoningEffortSnapshot,
    });

    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("openai", "/tmp/project", {
        modelId: "gpt-4.1",
      }),
    ).resolves.toEqual({
      sessionId: "acp-session-1",
      configOptionsSnapshot: {
        model: {
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        },
        reasoningEffort: reasoningEffortSnapshot,
      },
    });
  });

  it("does not resurrect provider defaults absent from the final model snapshot", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });
    mockSetProvider.mockResolvedValueOnce({
      model: { modelId: "gpt-5.5", modelName: "GPT-5.5" },
      reasoningEffort: reasoningEffortSnapshot,
    });
    mockSetModel.mockResolvedValueOnce({
      model: { modelId: "claude-fable", modelName: "Claude Fable" },
      reasoningEffort: null,
    });

    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("anthropic", "/tmp/project", {
        modelId: "claude-fable",
      }),
    ).resolves.toEqual({
      sessionId: "acp-session-1",
      configOptionsSnapshot: {
        model: { modelId: "claude-fable", modelName: "Claude Fable" },
        reasoningEffort: null,
      },
    });
  });

  it("rejects an explicit provider outside managed policy before creating", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    const { acpCreateSession } = await import("../acp");

    await expect(
      acpCreateSession("missing-provider", "/tmp/project", {
        modelId: "goose-gpt-5-5",
      }),
    ).rejects.toThrow("outside the managed Goose provider policy");

    expect(mockNewSession).not.toHaveBeenCalled();
  });

  it("does not inject the default model for another explicit provider", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    mockNewSession.mockResolvedValue({ sessionId: "other-session" });
    const { acpCreateSession } = await import("../acp");

    await acpCreateSession("other-managed", "/tmp/project");

    expect(mockSetProvider).toHaveBeenCalledWith(
      "other-session",
      "other-managed",
    );
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it.each([
    "claude-acp",
    "codex-acp",
    "copilot-acp",
    "amp-acp",
    "cursor-agent",
  ])("keeps the %s harness outside Goose provider policy", async (harnessId) => {
    await setRuntimeConfig(managedRuntimeConfig);
    mockNewSession.mockResolvedValue({ sessionId: `session-${harnessId}` });
    const { acpCreateSession } = await import("../acp");

    await acpCreateSession(harnessId, "/tmp/project", {
      modelId: "harness-model",
    });

    expect(mockSetProvider).toHaveBeenCalledWith(
      `session-${harnessId}`,
      harnessId,
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      `session-${harnessId}`,
      "harness-model",
      noRequestModelContext(harnessId),
    );
  });
});

describe("acpDuplicateSession", () => {
  const forkedSession = {
    sessionId: "session-2",
    title: "Fork",
    userSetName: false,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("delegates the session id and working dir to direct ACP", async () => {
    mockForkSession.mockResolvedValueOnce(forkedSession);

    const { acpDuplicateSession } = await import("../acp");

    await expect(
      acpDuplicateSession("session-1", "/tmp/project"),
    ).resolves.toEqual(forkedSession);
    expect(mockForkSession).toHaveBeenCalledWith(
      "session-1",
      "/tmp/project",
      undefined,
    );
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it("delegates fork options to direct ACP", async () => {
    mockForkSession.mockResolvedValueOnce(forkedSession);

    const { acpDuplicateSession } = await import("../acp");

    await acpDuplicateSession("session-1", "/tmp/project", undefined, {
      conversationBefore: 1_700_000_123,
    });

    expect(mockForkSession).toHaveBeenCalledWith("session-1", "/tmp/project", {
      conversationBefore: 1_700_000_123,
    });
  });

  it("renames duplicated sessions when a duplicate title is provided", async () => {
    mockForkSession.mockResolvedValueOnce(forkedSession);

    const { acpDuplicateSession } = await import("../acp");

    await expect(
      acpDuplicateSession("session-1", "/tmp/project", "Copy of Chat One"),
    ).resolves.toEqual({ ...forkedSession, title: "Copy of Chat One" });
    expect(mockForkSession).toHaveBeenCalledWith(
      "session-1",
      "/tmp/project",
      undefined,
    );
    expect(mockRenameSession).toHaveBeenCalledWith(
      "session-2",
      "Copy of Chat One",
    );
  });

  it("keeps the duplicated session when the cosmetic rename fails", async () => {
    const error = new Error("rename failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockForkSession.mockResolvedValueOnce(forkedSession);
    mockRenameSession.mockRejectedValueOnce(error);

    const { acpDuplicateSession } = await import("../acp");

    await expect(
      acpDuplicateSession("session-1", "/tmp/project", "Copy of Chat One"),
    ).resolves.toEqual(forkedSession);
    expect(mockRenameSession).toHaveBeenCalledWith(
      "session-2",
      "Copy of Chat One",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to rename duplicated session:",
      error,
    );
    consoleError.mockRestore();
  });
});

describe("acpPrepareSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("loads the existing ACP session instead of creating a replacement", async () => {
    mockLoadSession.mockResolvedValue(undefined);

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpPrepareSession } = await import("../acp");

    await expect(
      acpPrepareSession("acp-session-1", "openai", "/tmp/project"),
    ).resolves.toEqual({ model: null, reasoningEffort: null });

    expect(mockLoadSession).toHaveBeenCalledWith(
      "acp-session-1",
      "/tmp/project",
    );
    expect(mockNewSession).not.toHaveBeenCalled();
    expect(mockSetProvider).toHaveBeenCalledWith(
      "acp-session-1",
      "openai",
      noRequestProviderContext,
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });

  it("rejects a provider outside managed policy before loading the session", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    const { acpPrepareSession } = await import("../acp");

    await expect(
      acpPrepareSession("legacy-session", "missing-provider", "/tmp/project"),
    ).rejects.toThrow(
      "Provider missing-provider is outside the managed Goose provider policy",
    );
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it("rejects the Goose model sentinel before loading the session", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    const { acpPrepareSession } = await import("../acp");

    await expect(
      acpPrepareSession("acp-session-1", "databricks_v2", "/tmp/project", {
        modelId: "goose",
      }),
    ).rejects.toThrow("Invalid model id: goose");

    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("allows upstream models omitted from recommendation metadata", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    const { acpPrepareSession } = await import("../acp");

    await acpPrepareSession("other-session", "other-managed", "/tmp/project", {
      modelId: "new-upstream-model",
    });

    expect(mockSetModel).toHaveBeenCalledWith(
      "other-session",
      "new-upstream-model",
      noRequestModelContext("other-managed"),
    );
  });

  it("does not overwrite a valid model when re-preparing the same managed provider", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpPrepareSession } = await import("../acp");
    sessionRegistry.registerPreparedSession(
      "managed-session",
      "databricks_v2",
      "/tmp/project",
    );

    await acpPrepareSession("managed-session", "databricks_v2", "/tmp/project");

    expect(mockSetProvider).not.toHaveBeenCalled();
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("locks Goose sessions when runtime policy is unavailable", async () => {
    const { useRuntimeConfigStore } = await import(
      "@/shared/runtime-config/runtimeConfigStore"
    );
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "unavailable",
        source: "bundledFile",
        reason: "missing",
        message: "bundled policy missing",
      },
      config: DEFAULT_RUNTIME_CONFIG,
    });
    const { acpPrepareSession } = await import("../acp");

    await expect(
      acpPrepareSession("acp-session-1", "goose", "/tmp/project"),
    ).rejects.toThrow("Goose provider policy is unavailable");
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it("surfaces load failures instead of creating a new ACP session", async () => {
    mockLoadSession.mockRejectedValueOnce(new Error("missing session"));

    const { acpPrepareSession } = await import("../acp");

    await expect(
      acpPrepareSession("acp-session-1", "openai", "/tmp/project"),
    ).rejects.toThrow("missing session");

    expect(mockNewSession).not.toHaveBeenCalled();
    expect(mockSetProvider).not.toHaveBeenCalled();
  });
});
