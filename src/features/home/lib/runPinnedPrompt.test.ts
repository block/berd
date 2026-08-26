import { describe, expect, it, vi } from "vitest";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import type { Persona } from "@/shared/types/agents";
import { runPinnedPrompt, type RunPinnedPromptDeps } from "./runPinnedPrompt";

const TARGET: SessionExecutionTarget = {
  harnessId: "goose",
  modelProviderId: "anthropic",
  modelId: "claude-sonnet-4",
  modelName: "Claude Sonnet 4",
};

const FALLBACK_TARGET: SessionExecutionTarget = {
  harnessId: "goose",
  modelProviderId: "openai",
  modelId: "gpt-5",
  modelName: "GPT-5",
};

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "agent-1",
    displayName: "Agent One",
    systemPrompt: "You are a focused coding agent.",
    isBuiltin: false,
    writable: true,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<RunPinnedPromptDeps> = {},
): RunPinnedPromptDeps {
  return {
    personas: [persona()],
    resolveExecutionTarget: vi.fn(() => TARGET),
    resolveFallbackExecutionTarget: vi.fn(() => FALLBACK_TARGET),
    compose: vi.fn(),
    onAgentUnavailable: vi.fn(),
    ...overrides,
  };
}

describe("runPinnedPrompt", () => {
  it("composes with the resolved persona and execution target", async () => {
    const deps = makeDeps();

    const sent = await runPinnedPrompt(
      { text: "Summarize my inbox", agentId: "agent-1" },
      deps,
    );

    expect(sent).toBe(true);
    expect(deps.compose).toHaveBeenCalledWith("Summarize my inbox", {
      personaId: "agent-1",
      executionTarget: TARGET,
    });
    expect(deps.onAgentUnavailable).not.toHaveBeenCalled();
  });

  it("falls back to the composer target when the persona cannot resolve one", async () => {
    const deps = makeDeps({ resolveExecutionTarget: vi.fn(() => undefined) });

    const sent = await runPinnedPrompt(
      { text: "Summarize my inbox", agentId: "agent-1" },
      deps,
    );

    expect(sent).toBe(true);
    expect(deps.compose).toHaveBeenCalledWith("Summarize my inbox", {
      personaId: "agent-1",
      executionTarget: FALLBACK_TARGET,
    });
  });

  it("composes without an agent using the composer's current target", async () => {
    const deps = makeDeps();

    const sent = await runPinnedPrompt({ text: "Summarize my inbox" }, deps);

    expect(sent).toBe(true);
    expect(deps.compose).toHaveBeenCalledWith("Summarize my inbox", {
      personaId: null,
      executionTarget: FALLBACK_TARGET,
    });
    expect(deps.resolveExecutionTarget).not.toHaveBeenCalled();
  });

  it("omits the execution target only when no fallback exists either", async () => {
    const deps = makeDeps({
      resolveFallbackExecutionTarget: vi.fn(() => undefined),
    });

    const sent = await runPinnedPrompt({ text: "Summarize my inbox" }, deps);

    expect(sent).toBe(true);
    expect(deps.compose).toHaveBeenCalledWith("Summarize my inbox", {
      personaId: null,
    });
  });

  it("reports the agent unavailable and does not send when the persona is gone", async () => {
    const deps = makeDeps({ personas: [] });

    const sent = await runPinnedPrompt(
      { text: "Summarize my inbox", agentId: "agent-gone" },
      deps,
    );

    expect(sent).toBe(false);
    expect(deps.onAgentUnavailable).toHaveBeenCalledTimes(1);
    expect(deps.compose).not.toHaveBeenCalled();
  });

  it("does not send empty text", async () => {
    const deps = makeDeps();

    const sent = await runPinnedPrompt({ text: "   " }, deps);

    expect(sent).toBe(false);
    expect(deps.compose).not.toHaveBeenCalled();
    expect(deps.onAgentUnavailable).not.toHaveBeenCalled();
  });

  it("trims the prompt text before composing", async () => {
    const deps = makeDeps();

    await runPinnedPrompt({ text: "  Summarize my inbox\n" }, deps);

    expect(deps.compose).toHaveBeenCalledWith("Summarize my inbox", {
      personaId: null,
      executionTarget: FALLBACK_TARGET,
    });
  });
});
