import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadSession = vi.fn();
const mockNewSession = vi.fn();
const mockSetProvider = vi.fn();
const mockSetModel = vi.fn();
const mockPrompt = vi.fn();
const mockAppendSessionSystemPrompt = vi.fn();

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
  forkSession: vi.fn(),
  cancelSession: vi.fn(),
}));

vi.mock("../acpNotificationHandler", () => ({
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
  });

  it("updates the session system prompt before sending only user-visible prompt content", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { acpSendMessage } = await import("../acp");

    sessionRegistry.registerPreparedSession(
      "acp-session-1",
      "goose",
      "/tmp/project",
    );

    await acpSendMessage("acp-session-1", "hello", {
      systemPrompt: "You are Starfriend.",
      assistantPrompt: "Use these skills for this request: goose-help.",
    });

    expect(mockAppendSessionSystemPrompt).toHaveBeenCalledWith(
      "acp-session-1",
      "client_system_prompt",
      "You are Starfriend.",
    );
    expect(mockPrompt).toHaveBeenCalledWith(
      "acp-session-1",
      [
        {
          type: "text",
          text: "Use these skills for this request: goose-help.",
          annotations: { audience: ["assistant"] },
        },
        { type: "text", text: "hello" },
      ],
      undefined,
    );
  });

  it("hands the persona off in-band on the first prompt for external agents", async () => {
    const sessionRegistry = await import("../acpSessionRegistry");
    const { __resetAllPersonaHandoffs } = await import("../acpPersonaHandoff");
    const { acpSendMessage } = await import("../acp");
    __resetAllPersonaHandoffs();

    sessionRegistry.registerPreparedSession(
      "acp-session-claude",
      "claude-acp",
      "/tmp/project",
    );

    await acpSendMessage("acp-session-claude", "hello", {
      systemPrompt: "You are Starfriend.",
    });

    // External agents ignore the goose system-prompt ext method, so we must
    // not call it for them.
    expect(mockAppendSessionSystemPrompt).not.toHaveBeenCalled();

    const [, blocks] = mockPrompt.mock.calls[0];
    expect(blocks[0].annotations).toEqual({ audience: ["assistant"] });
    expect(blocks[0].text).toContain("You are Starfriend.");
    expect(blocks[blocks.length - 1]).toEqual({ type: "text", text: "hello" });
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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
});

describe("acpCreateSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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
    ).resolves.toEqual({ sessionId: "acp-session-1" });

    expect(mockNewSession).toHaveBeenCalledWith(
      "/tmp/project",
      "openai",
      "project-1",
      "persona-1",
    );
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSetProvider).toHaveBeenCalledWith("acp-session-1", "openai");
    expect(mockSetModel).toHaveBeenCalledWith("acp-session-1", "gpt-4.1");
    expect(sessionRegistry.isSessionPrepared("acp-session-1")).toBe(true);
  });
});

describe("acpPrepareSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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
