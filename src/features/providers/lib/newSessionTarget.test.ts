import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveNewSessionTarget,
  type NewSessionTargetSnapshot,
} from "./newSessionTarget";

const readyDefault = {
  status: "ready" as const,
  providerId: "openai",
  modelId: "gpt-4o",
};
const needsSetup = {
  status: "needs_setup" as const,
  reason: "missing_defaults" as const,
};

function snapshot(
  overrides: Partial<NewSessionTargetSnapshot> = {},
): NewSessionTargetSnapshot {
  return {
    defaultProviderReadiness: readyDefault,
    readyAgentIds: new Set(["goose", "codex"]),
    configuredAgentIds: new Set(),
    catalogAgentIds: ["goose", "claude", "codex"],
    persistedProviderId: null,
    policy: { requireGooseDefaultProvider: true },
    ...overrides,
  };
}

describe("resolveNewSessionTarget", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([
    {
      name: "uses a ready persisted Goose selection",
      snapshot: snapshot({ persistedProviderId: "goose" }),
      request: {},
      expected: {
        status: "ready",
        providerId: "goose",
        modelId: "gpt-4o",
        modelName: "gpt-4o",
        provenance: "persisted",
      },
    },
    {
      name: "silently falls back from stale Goose to the first ready agent",
      snapshot: snapshot({
        persistedProviderId: "goose",
        defaultProviderReadiness: needsSetup,
        readyAgentIds: new Set(["codex"]),
      }),
      request: {},
      expected: {
        status: "ready",
        providerId: "codex",
        modelId: undefined,
        provenance: "fallback",
      },
    },
    {
      name: "prefers the ready Goose backend default over another agent",
      snapshot: snapshot({ persistedProviderId: "claude" }),
      request: {},
      expected: {
        status: "ready",
        providerId: "goose",
        modelId: "gpt-4o",
        modelName: "gpt-4o",
        provenance: "goose_default",
      },
    },
    {
      name: "blocks an explicit unavailable choice",
      snapshot: snapshot(),
      request: { providerId: "claude", modelId: "opus" },
      expected: {
        status: "blocked",
        reason: "explicit_target_unready",
        providerId: "claude",
      },
    },
    {
      name: "requires setup when no agent is ready",
      snapshot: snapshot({
        defaultProviderReadiness: needsSetup,
        readyAgentIds: new Set(),
      }),
      request: {},
      expected: { status: "needs_setup" },
    },
  ])("$name", ({ snapshot: input, request, expected }) => {
    expect(resolveNewSessionTarget(input, request)).toEqual(expected);
  });

  it("preserves an explicit model for a ready explicit choice", () => {
    expect(
      resolveNewSessionTarget(snapshot(), {
        providerId: "codex",
        modelId: "o3",
      }),
    ).toEqual({
      status: "ready",
      providerId: "codex",
      modelId: "o3",
      modelName: "o3",
      provenance: "explicit",
    });
  });

  it("accepts the provider already verified by default readiness", () => {
    expect(
      resolveNewSessionTarget(snapshot(), {
        providerId: "openai",
        modelId: "gpt-4o",
      }),
    ).toMatchObject({
      status: "ready",
      providerId: "openai",
      modelId: "gpt-4o",
      provenance: "explicit",
    });
  });

  it("uses the stored new-chat model without replacing the Goose harness", () => {
    expect(
      resolveNewSessionTarget(
        snapshot({
          persistedProviderId: "goose",
          persistedModelPreference: {
            modelId: "synthetic-model",
            modelName: "Synthetic model",
            providerId: "chatgpt_codex",
          },
        }),
      ),
    ).toMatchObject({
      status: "ready",
      providerId: "goose",
      modelId: "synthetic-model",
      modelName: "Synthetic model",
      provenance: "persisted",
    });
  });

  it("accepts a configured explicit agent through the pure resolver", () => {
    expect(
      resolveNewSessionTarget(
        snapshot({
          readyAgentIds: new Set(),
          configuredAgentIds: new Set(["claude"]),
        }),
        { providerId: "claude", modelId: "opus" },
      ),
    ).toMatchObject({
      status: "ready",
      providerId: "claude",
      modelId: "opus",
      provenance: "explicit",
    });
  });

  it("does not misclassify unknown Goose readiness as missing setup", () => {
    expect(
      resolveNewSessionTarget(
        snapshot({
          defaultProviderReadiness: {
            status: "unknown",
            error: "read failed",
          },
          readyAgentIds: new Set(),
          persistedProviderId: "goose",
        }),
      ),
    ).toEqual({
      status: "ready",
      providerId: "goose",
      modelId: undefined,
      provenance: "persisted",
    });
  });

  it("does not gate Goose defaults in restricted builds", () => {
    expect(
      resolveNewSessionTarget(
        snapshot({
          defaultProviderReadiness: needsSetup,
          readyAgentIds: new Set(),
          persistedProviderId: "goose",
          policy: { requireGooseDefaultProvider: false },
        }),
      ),
    ).toEqual({
      status: "ready",
      providerId: "goose",
      modelId: undefined,
      provenance: "persisted",
    });
  });
});
