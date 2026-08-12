import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAllPersonaHandoffs,
  buildPersonaHandoffPreamble,
  claimPersonaHandoff,
  isExternalAgentProvider,
  isGooseManagedProvider,
  resetPersonaHandoff,
  toWireProviderId,
} from "../acpPersonaHandoff";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import {
  INITIAL_RUNTIME_CONFIG_RESULT,
  useRuntimeConfigStore,
} from "@/shared/runtime-config/runtimeConfigStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";

beforeEach(() => {
  __resetAllPersonaHandoffs();
  useRuntimeConfigStore.setState({
    loaded: true,
    result: INITIAL_RUNTIME_CONFIG_RESULT,
    config: DEFAULT_RUNTIME_CONFIG,
  });
  useDefaultProviderReadinessStore.setState({ readiness: null });
});

describe("toWireProviderId", () => {
  it("translates the goose agent sentinel to the runtime default model provider", () => {
    expect(toWireProviderId("goose")).toBe("goose");

    useRuntimeConfigStore.setState({
      config: {
        ...DEFAULT_RUNTIME_CONFIG,
        goose: {
          defaultModelProviderId: "runtime_provider",
          defaultModelId: "runtime-model",
          modelProviders: [
            {
              id: "runtime_provider",
              displayName: "Runtime Provider",
              models: [{ id: "runtime-model", name: "Runtime Model" }],
            },
          ],
        },
      },
    });

    expect(toWireProviderId("goose")).toBe("runtime_provider");
  });

  it("uses the backend-saved Goose provider when it differs from runtime defaults", () => {
    useRuntimeConfigStore.setState({
      config: {
        ...DEFAULT_RUNTIME_CONFIG,
        goose: {
          defaultModelProviderId: "runtime_provider",
          defaultModelId: "runtime-model",
          modelProviders: [],
        },
      },
    });
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });

    expect(toWireProviderId("goose")).toBe("databricks_v2");
  });

  it("passes real provider ids through unchanged", () => {
    expect(toWireProviderId("databricks_v2")).toBe("databricks_v2");
    expect(toWireProviderId("claude-acp")).toBe("claude-acp");
    expect(toWireProviderId("codex-acp")).toBe("codex-acp");
  });
});

describe("isExternalAgentProvider", () => {
  it("treats goose as not external", () => {
    expect(isExternalAgentProvider("goose")).toBe(false);
  });

  it("treats goose model providers as not external", () => {
    expect(isGooseManagedProvider("databricks_v2")).toBe(true);
    expect(isExternalAgentProvider("databricks_v2")).toBe(false);
  });

  it("treats other agent harnesses as external", () => {
    expect(isExternalAgentProvider("claude-acp")).toBe(true);
    expect(isExternalAgentProvider("codex-acp")).toBe(true);
  });

  it("treats unknown/undefined provider as not external", () => {
    expect(isExternalAgentProvider(undefined)).toBe(false);
  });
});

describe("buildPersonaHandoffPreamble", () => {
  it("frames the persona as a system-prompt handoff and includes the text", () => {
    const preamble = buildPersonaHandoffPreamble("You are Starfriend.");
    expect(preamble).toContain("You are Starfriend.");
    expect(preamble.toLowerCase()).toContain("session");
  });

  it("trims the persona body", () => {
    expect(buildPersonaHandoffPreamble("  hi  ")).toContain("\nhi\n");
  });
});

describe("claimPersonaHandoff", () => {
  it("returns null for the goose provider", () => {
    expect(
      claimPersonaHandoff("s1", "goose", "You are Starfriend."),
    ).toBeNull();
  });

  it("returns null for goose model providers", () => {
    expect(
      claimPersonaHandoff("s1", "databricks_v2", "You are Starfriend."),
    ).toBeNull();
  });

  it("returns null when there is no persona prompt", () => {
    expect(claimPersonaHandoff("s1", "claude-acp", undefined)).toBeNull();
    expect(claimPersonaHandoff("s1", "claude-acp", "   ")).toBeNull();
  });

  it("returns the preamble once per (session, provider, persona)", () => {
    const first = claimPersonaHandoff(
      "s1",
      "claude-acp",
      "You are Starfriend.",
    );
    expect(first).toContain("You are Starfriend.");
    expect(
      claimPersonaHandoff("s1", "claude-acp", "You are Starfriend."),
    ).toBeNull();
  });

  it("re-injects when the provider changes (agent switch)", () => {
    claimPersonaHandoff("s1", "claude-acp", "You are Starfriend.");
    expect(
      claimPersonaHandoff("s1", "codex-acp", "You are Starfriend."),
    ).toContain("You are Starfriend.");
  });

  it("re-injects when the persona prompt changes", () => {
    claimPersonaHandoff("s1", "claude-acp", "You are Starfriend.");
    expect(
      claimPersonaHandoff("s1", "claude-acp", "You are Gloopy."),
    ).toContain("You are Gloopy.");
  });

  it("tracks handoffs per session independently", () => {
    claimPersonaHandoff("s1", "claude-acp", "You are Starfriend.");
    expect(
      claimPersonaHandoff("s2", "claude-acp", "You are Starfriend."),
    ).toContain("You are Starfriend.");
  });
});

describe("resetPersonaHandoff", () => {
  it("forces re-injection on the next send for that session only", () => {
    claimPersonaHandoff("s1", "claude-acp", "You are Starfriend.");
    claimPersonaHandoff("s2", "claude-acp", "You are Starfriend.");

    resetPersonaHandoff("s1");

    expect(
      claimPersonaHandoff("s1", "claude-acp", "You are Starfriend."),
    ).toContain("You are Starfriend.");
    expect(
      claimPersonaHandoff("s2", "claude-acp", "You are Starfriend."),
    ).toBeNull();
  });
});
