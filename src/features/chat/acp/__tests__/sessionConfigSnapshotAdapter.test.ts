import { beginModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelExecutionTarget,
  SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import {
  acquireSessionDispatchTarget,
  getSessionTargetSelection,
  resetSessionTargetCoordinatorsForTests,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  applySessionConfigOptionsSnapshot,
  type AcpSessionConfigSnapshotContext,
} from "@/shared/api/acpSessionConfigSnapshots";
import {
  applyChatSessionConfigOptionsSnapshot,
  registerChatSessionConfigSnapshotHandlers,
} from "../sessionConfigSnapshotAdapter";

const sessionId = "acp-session";
const gooseProviderTarget = {
  harnessId: "goose",
  modelProviderId: "databricks_v2",
} as const satisfies SessionExecutionTarget;
const gpt55Target = {
  ...gooseProviderTarget,
  modelId: "gpt-5.5",
  modelName: "GPT-5.5",
} as const satisfies SessionExecutionTarget;
const gpt56Target = {
  ...gooseProviderTarget,
  modelId: "gpt-5.6-sol",
  modelName: "GPT-5.6 Sol",
} as const satisfies SessionExecutionTarget;

function addSession(executionTargetSource?: "ui" | "acp") {
  useChatSessionStore.getState().addSession({
    id: sessionId,
    title: "Chat",
    executionTarget: gooseProviderTarget,
    ...(executionTargetSource ? { executionTargetSource } : {}),
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    messageCount: 0,
  });
}

function beginModelIntent(
  target: ModelExecutionTarget,
  previousTarget: SessionExecutionTarget,
) {
  beginModelSelectionIntent(sessionId, {
    requestId: "model-request-current",
    target,
    previousTarget,
  });
}

function beginProviderIntent() {
  beginModelSelectionIntent(sessionId, {
    requestId: "provider-request-current",
    target: { harnessId: "goose", modelProviderId: "anthropic" },
    previousTarget: gooseProviderTarget,
  });
}

function createConfigResponse({
  modelId,
  reasoningEffort,
}: {
  modelId?: string;
  reasoningEffort?: string;
}) {
  const configOptions: unknown[] = [];
  if (modelId) {
    configOptions.push({
      id: "model",
      category: "model",
      kind: {
        type: "select",
        currentValue: modelId,
        options: {
          type: "ungrouped",
          values: [{ value: modelId, name: modelId }],
        },
      },
    });
  }
  if (reasoningEffort) {
    configOptions.push({
      id: "thinking_effort",
      category: "thought_level",
      kind: {
        type: "select",
        currentValue: reasoningEffort,
        options: {
          type: "ungrouped",
          values: [{ value: reasoningEffort, name: reasoningEffort }],
        },
      },
    });
  }
  return { configOptions };
}

function applySnapshot(
  modelId: string,
  context: AcpSessionConfigSnapshotContext,
  reasoningEffort = "high",
) {
  applyChatSessionConfigOptionsSnapshot(
    sessionId,
    createConfigResponse({ modelId, reasoningEffort }),
    context,
  );
}

function getSession() {
  return useChatSessionStore.getState().getSession(sessionId);
}

describe("sessionConfigSnapshotAdapter", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    registerChatSessionConfigSnapshotHandlers();
    useChatSessionStore.setState({
      sessions: [],
    });
  });

  it("accepts model and reasoning snapshots owned by the model request", () => {
    addSession();
    beginModelIntent(gpt55Target, {
      ...gooseProviderTarget,
      modelId: "claude-opus-4-8",
      modelName: "Claude Opus 4.8",
    });

    applySnapshot("gpt-5.5", {
      origin: "response",
      requestId: "model-request-current",
      providerId: "databricks_v2",
      modelId: "gpt-5.5",
    });

    expect(getSession()).toMatchObject({
      executionTarget: { ...gpt55Target, modelName: "gpt-5.5" },
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
      },
    });
  });

  it.each([
    {
      name: "an older model request",
      snapshotModelId: "gpt-5.6-sol",
      context: {
        origin: "response" as const,
        requestId: "model-request-older",
        providerId: "databricks_v2",
        modelId: "gpt-5.6-sol",
      },
    },
    {
      name: "another provider with the same model id",
      snapshotModelId: "gpt-5.6-sol",
      context: {
        origin: "response" as const,
        requestId: "model-request-current",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
      },
    },
    {
      name: "an unowned notification",
      snapshotModelId: "gpt-5.6-sol",
      context: {
        origin: "notification" as const,
        requestId: "model-request-current",
        providerId: "databricks_v2",
        modelId: "gpt-5.6-sol",
      },
    },
    {
      name: "the intermediate provider default",
      snapshotModelId: "gpt-5.5",
      context: {
        origin: "response" as const,
        requestId: "model-request-current",
        providerId: "databricks_v2",
        modelId: "gpt-5.5",
      },
    },
  ])("rejects snapshots from $name", ({ snapshotModelId, context }) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession();
    beginModelIntent(gpt56Target, gpt55Target);

    applySnapshot(snapshotModelId, context);

    expect(getSession()?.executionTarget).toEqual(gpt56Target);
    expect(getSession()?.reasoningEffort).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("hydrates model and reasoning acknowledged by the provider request", () => {
    addSession();
    beginProviderIntent();

    applySnapshot(
      "claude-fable",
      {
        origin: "response",
        requestId: "provider-request-current",
        providerId: "anthropic",
        modelId: "claude-fable",
      },
      "medium",
    );

    expect(getSession()).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-fable",
        modelName: "claude-fable",
      },
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "medium",
      },
    });
  });

  it("rejects a model acknowledged by a different provider", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession();
    beginProviderIntent();

    applySnapshot("gpt-5.5", {
      origin: "response",
      requestId: "provider-request-current",
      providerId: "openai",
      modelId: "gpt-5.5",
    });

    expect(getSession()?.executionTarget?.modelId).toBeUndefined();
    expect(getSession()?.reasoningEffort).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("does not materialize an anonymous model onto a UI-owned provider target", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession("ui");

    applySnapshot("gpt-5.5", { origin: "notification" }, "medium");

    expect(getSession()?.executionTarget).toEqual(gooseProviderTarget);
    expect(getSession()?.reasoningEffort).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("drops reasoning from an anonymous notification for a newer UI model", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession("ui");
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(sessionId, gpt56Target);

    applySnapshot("gpt-5.5", { origin: "notification" }, "medium");

    expect(getSession()?.executionTarget).toEqual(gpt56Target);
    expect(getSession()?.reasoningEffort).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("accepts a reasoning response for a settled UI target", () => {
    addSession("ui");
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(sessionId, gpt56Target);

    applyChatSessionConfigOptionsSnapshot(
      sessionId,
      createConfigResponse({ reasoningEffort: "medium" }),
      {
        origin: "response",
        providerId: "databricks_v2",
        modelId: "gpt-5.6-sol",
      },
    );

    expect(getSession()?.reasoningEffort).toMatchObject({
      configId: "thinking_effort",
      currentValue: "medium",
    });
  });

  it("drops a reasoning response from the previously selected model", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession("ui");
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(sessionId, gpt56Target);

    applyChatSessionConfigOptionsSnapshot(
      sessionId,
      createConfigResponse({ reasoningEffort: "medium" }),
      {
        origin: "response",
        providerId: "databricks_v2",
        modelId: "gpt-5.5",
      },
    );

    expect(getSession()?.reasoningEffort).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("drops an older reasoning response for the current model", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession("ui");
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(sessionId, gpt56Target);
    useChatSessionStore.getState().patchSession(sessionId, {
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
        options: [],
      },
    });

    applyChatSessionConfigOptionsSnapshot(
      sessionId,
      createConfigResponse({ reasoningEffort: "medium" }),
      {
        origin: "response",
        providerId: "databricks_v2",
        modelId: "gpt-5.6-sol",
        reasoningEffortValue: "medium",
      },
    );

    expect(getSession()?.reasoningEffort?.currentValue).toBe("high");
    warnSpy.mockRestore();
  });

  it("keeps anonymous paired reasoning off a UI-owned matching target", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession("ui");
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(sessionId, gpt56Target);

    applySnapshot("gpt-5.6-sol", { origin: "notification" }, "medium");

    expect(getSession()?.executionTarget).toEqual({
      ...gpt56Target,
      modelName: "gpt-5.6-sol",
    });
    expect(getSession()?.reasoningEffort).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("materializes a matching provider-only lease atomically with paired reasoning", () => {
    addSession("acp");
    const lease = acquireSessionDispatchTarget(sessionId);
    const observations: Array<{
      modelId?: string;
      reasoningEffort?: string;
      source?: string;
    }> = [];
    const unsubscribe = useChatSessionStore.subscribe((state) => {
      const session = state.getSession(sessionId);
      observations.push({
        modelId: session?.executionTarget?.modelId,
        reasoningEffort: session?.reasoningEffort?.currentValue,
        source: session?.executionTargetSource,
      });
    });

    applySnapshot("gpt-5.5", { origin: "notification" }, "medium");
    unsubscribe();

    expect(observations).toEqual([
      {
        modelId: "gpt-5.5",
        reasoningEffort: "medium",
        source: "acp",
      },
    ]);
    lease.release?.();
  });

  it("hydrates snapshots when ACP owns the target and no request is pending", () => {
    addSession("acp");

    applySnapshot("gpt-5.5", { origin: "notification" }, "medium");

    expect(getSession()).toMatchObject({
      executionTarget: { ...gpt55Target, modelName: "gpt-5.5" },
      executionTargetSource: "acp",
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "medium",
      },
    });
  });

  it.each([
    "response",
    "notification",
  ] as const)("defers a divergent target and its reasoning as one %s observation", (origin) => {
    addSession("acp");
    useChatSessionStore
      .getState()
      .hydrateSessionExecutionTarget(sessionId, gpt55Target);
    useChatSessionStore.getState().patchSession(sessionId, {
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "low",
        options: [{ id: "low", name: "low" }],
      },
    });
    const lease = acquireSessionDispatchTarget(sessionId);
    expect(lease.status).toBe("acquired");

    applySnapshot(
      "gpt-5.6-sol",
      {
        origin,
        ...(origin === "response"
          ? { providerId: "databricks_v2", modelId: "gpt-5.6-sol" }
          : {}),
      },
      "high",
    );

    expect(getSession()).toMatchObject({
      executionTarget: gpt55Target,
      reasoningEffort: { currentValue: "low" },
    });
    lease.release?.();
    expect(getSession()).toMatchObject({
      executionTarget: { ...gpt56Target, modelName: "gpt-5.6-sol" },
      reasoningEffort: { currentValue: "high" },
    });
  });

  it("routes registry-backed responses through the composite observation", () => {
    addSession("acp");
    useChatSessionStore
      .getState()
      .hydrateSessionExecutionTarget(sessionId, gpt55Target);
    const lease = acquireSessionDispatchTarget(sessionId);

    applySessionConfigOptionsSnapshot(
      sessionId,
      createConfigResponse({
        modelId: "gpt-5.6-sol",
        reasoningEffort: "medium",
      }),
      {
        origin: "response",
        providerId: "databricks_v2",
        modelId: "gpt-5.6-sol",
      },
    );

    expect(getSession()?.executionTarget).toEqual(gpt55Target);
    expect(getSession()?.reasoningEffort).toBeUndefined();
    lease.release?.();
    expect(getSession()).toMatchObject({
      executionTarget: { ...gpt56Target, modelName: "gpt-5.6-sol" },
      reasoningEffort: { currentValue: "medium" },
    });
  });

  it("keeps deferred user intent ahead of an external target and reasoning pair", () => {
    addSession("acp");
    useChatSessionStore
      .getState()
      .hydrateSessionExecutionTarget(sessionId, gpt55Target);
    const lease = acquireSessionDispatchTarget(sessionId);
    beginModelSelectionIntent(sessionId, {
      requestId: "pick-user",
      target: gpt55Target,
      previousTarget: gpt55Target,
    });

    applySnapshot(
      "gpt-5.6-sol",
      {
        origin: "notification",
      },
      "high",
    );
    lease.release?.();

    expect(getSession()?.executionTarget).toEqual(gpt55Target);
    expect(getSession()?.reasoningEffort).toBeUndefined();
    expect(getSessionTargetSelection(sessionId)).toMatchObject({
      operationId: "pick-user",
      target: gpt55Target,
    });
  });

  it("keeps only the latest external target and reasoning pair during dispatch", () => {
    addSession("acp");
    useChatSessionStore
      .getState()
      .hydrateSessionExecutionTarget(sessionId, gpt55Target);
    const lease = acquireSessionDispatchTarget(sessionId);

    applySnapshot("gpt-5.6-sol", { origin: "notification" }, "medium");
    applySnapshot("gpt-5.7", { origin: "notification" }, "high");
    lease.release?.();

    expect(getSession()).toMatchObject({
      executionTarget: {
        modelProviderId: "databricks_v2",
        modelId: "gpt-5.7",
      },
      reasoningEffort: { currentValue: "high" },
    });
  });

  it("materializes a matching provider-only lease with paired reasoning", () => {
    addSession("acp");
    const lease = acquireSessionDispatchTarget(sessionId);

    applySnapshot("gpt-5.5", { origin: "notification" }, "medium");

    expect(getSession()).toMatchObject({
      executionTarget: { ...gpt55Target, modelName: "gpt-5.5" },
      reasoningEffort: { currentValue: "medium" },
    });
    lease.release?.();
  });

  it("clears stale reasoning when a divergent observation has none", () => {
    addSession("acp");
    useChatSessionStore
      .getState()
      .hydrateSessionExecutionTarget(sessionId, gpt55Target);
    useChatSessionStore.getState().patchSession(sessionId, {
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "low",
        options: [{ id: "low", name: "low" }],
      },
    });
    const lease = acquireSessionDispatchTarget(sessionId);

    applyChatSessionConfigOptionsSnapshot(
      sessionId,
      createConfigResponse({ modelId: "gpt-5.6-sol" }),
      { origin: "notification" },
    );
    lease.release?.();

    expect(getSession()?.executionTarget).toMatchObject({
      modelId: "gpt-5.6-sol",
    });
    expect(getSession()?.reasoningEffort).toBeUndefined();
  });
});
