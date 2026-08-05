import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";

import {
  DEFAULT_STYLE_GUIDELINES_PROMPT,
  STYLE_GUIDELINES_STORAGE_KEY,
} from "@/shared/preferences/styleGuidelinesPreference";

const mockLoadSession = vi.fn();
const mockNewSession = vi.fn();
const mockSetProvider = vi.fn();
const mockSetModel = vi.fn();
const mockPrompt = vi.fn();
const mockAppendSessionSystemPrompt = vi.fn();
const mockForkSession = vi.fn();
const mockRenameSession = vi.fn();

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

vi.mock("../acpApi", () => ({
  listProviders: vi.fn(),
  prompt: (...args: unknown[]) => mockPrompt(...args),
  appendSessionSystemPrompt: (...args: unknown[]) =>
    mockAppendSessionSystemPrompt(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  listSessions: vi.fn(),
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  newSession: (...args: unknown[]) => mockNewSession(...args),
  exportSession: vi.fn(),
  importSession: vi.fn(),
  forkSession: (...args: unknown[]) => mockForkSession(...args),
  renameSession: (...args: unknown[]) => mockRenameSession(...args),
  cancelSession: vi.fn(),
}));

const mockGetBerdctlPreamble = vi.fn<() => string | null>(() => null);

vi.mock("@/features/berdctl/appPreamble", () => ({
  getBerdctlPreamble: () => mockGetBerdctlPreamble(),
}));

vi.mock("../acpActiveMessageTracking", () => ({
  setActiveMessageId: vi.fn(),
  clearActiveMessageId: vi.fn(),
}));

vi.mock("../sessionSearch", () => ({
  searchSessionsViaExports: vi.fn(),
}));

describe("acpSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // clearAllMocks clears call history but not return values; reset the
    // preamble to unavailable so tests opt in explicitly.
    mockGetBerdctlPreamble.mockReturnValue(null);
    localStorage.removeItem(STYLE_GUIDELINES_STORAGE_KEY);
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
      "berd_app_context",
      "",
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenNthCalledWith(
      4,
      sessionId,
      "client_system_prompt",
      "You are Starfriend.",
    );
    expect(mockAppendSessionSystemPrompt).toHaveBeenCalledTimes(4);
  });

  it("adds the default style guidelines when unset", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-default-style",
      "goose",
      "/tmp/project",
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
    );

    await acpSendMessage("acp-session-preamble", "hello", {});

    expect(mockAppendSessionSystemPrompt).toHaveBeenCalledWith(
      "acp-session-preamble",
      "berd_app_context",
      "[Berd]\nberdctl is on your PATH.",
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

  it("merges the persona handoff with a skill assistant prompt, persona first", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-codex",
      "codex-acp",
      "/tmp/project",
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
    );
    await acpSendMessage("acp-session-switch", "third", {
      systemPrompt: "You are Starfriend.",
    });
    expect(mockPrompt.mock.calls[2][1][0].text).toContain(
      "You are Starfriend.",
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
    );

    await expect(
      acpLoadSession("acp-session-1", "/tmp/replay"),
    ).rejects.toThrow("load failed");

    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
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
});

describe("acpCreateSession", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
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
    expect(mockSetModel).toHaveBeenCalledWith("acp-session-1", "gpt-4.1");
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
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
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });

  it("activates a deferred session through load, provider setup, and model setup", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-1" });

    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpCreateSession, acpPrepareSession, acpSetModel } = await import(
      "../acp"
    );

    const { sessionId } = await acpCreateSession("goose", "/tmp/project", {
      deferProviderSetup: true,
    });

    await acpPrepareSession(sessionId, "anthropic", "/tmp/project");
    await acpSetModel(sessionId, "claude-sonnet-4");

    expect(mockLoadSession).toHaveBeenCalledWith(
      "acp-session-1",
      "/tmp/project",
    );
    expect(mockSetProvider).toHaveBeenCalledWith("acp-session-1", "anthropic");
    expect(mockSetModel).toHaveBeenCalledWith(
      "acp-session-1",
      "claude-sonnet-4",
    );
    expect(mockLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetProvider.mock.invocationCallOrder[0],
    );
    expect(mockSetProvider.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetModel.mock.invocationCallOrder[0],
    );
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
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
});

describe("acpSetModel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  });

  it("skips redundant wire calls when the model is unchanged", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSetModel } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-model",
      "codex-acp",
      "/tmp/project",
    );

    // The chat send path re-applies the session config before every message;
    // only the first apply of a given model may reach the wire (the backend
    // rebuilds the provider on every set, destroying ACP child threads).
    await acpSetModel("acp-session-model", "gpt-5.5");
    await acpSetModel("acp-session-model", "gpt-5.5");
    await acpSetModel("acp-session-model", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetModel).toHaveBeenCalledWith("acp-session-model", "gpt-5.5");

    await acpSetModel("acp-session-model", "gpt-5.4");
    expect(mockSetModel).toHaveBeenCalledTimes(2);
    expect(mockSetModel).toHaveBeenLastCalledWith(
      "acp-session-model",
      "gpt-5.4",
    );
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
    );
  });

  it("dedupes the model applied during acpCreateSession", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "acp-session-created" });

    const { acpCreateSession, acpSetModel } = await import("../acp");

    await acpCreateSession("codex-acp", "/tmp/project", {
      modelId: "gpt-5.5",
    });
    expect(mockSetModel).toHaveBeenCalledTimes(1);

    await acpSetModel("acp-session-created", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  it("rejects model changes for sessions that have not been prepared", async () => {
    const { acpSetModel } = await import("../acp");

    await expect(
      acpSetModel("unknown-session", "legacy-model"),
    ).rejects.toThrow("Session not prepared");
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("rejects model changes until a disallowed provider is re-prepared", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSetModel } = await import("../acp");
    sessionRegistry.registerPreparedSession(
      "legacy-session",
      "databricks",
      "/tmp/project",
    );

    await expect(
      acpSetModel("legacy-session", "goose-gpt-5-5"),
    ).rejects.toThrow("outside the managed Goose provider policy");
    expect(mockSetModel).not.toHaveBeenCalled();
  });

  it("allows upstream models omitted from runtime recommendation metadata", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSetModel } = await import("../acp");
    sessionRegistry.registerPreparedSession(
      "other-session",
      "other-managed",
      "/tmp/project",
    );

    await expect(
      acpSetModel("other-session", "new-upstream-model"),
    ).resolves.toBeUndefined();
    expect(mockSetModel).toHaveBeenCalledWith(
      "other-session",
      "new-upstream-model",
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
    ).resolves.toBeUndefined();

    expect(mockLoadSession).toHaveBeenCalledWith(
      "acp-session-1",
      "/tmp/project",
    );
    expect(mockNewSession).not.toHaveBeenCalled();
    expect(mockSetProvider).toHaveBeenCalledWith("acp-session-1", "openai");
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });

  it("migrates a provider missing from the catalog without depending on catalog load order", async () => {
    await setRuntimeConfig(managedRuntimeConfig);
    mockLoadSession.mockResolvedValue(undefined);
    const { acpPrepareSession } = await import("../acp");

    await acpPrepareSession(
      "legacy-session",
      "missing-provider",
      "/tmp/project",
    );

    expect(mockSetProvider).toHaveBeenCalledWith(
      "legacy-session",
      "databricks_v2",
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "legacy-session",
      "goose-gpt-5-5",
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
