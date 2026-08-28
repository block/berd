import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";

const mockLoadSession = vi.fn();
const mockSetProvider = vi.fn();
const mockSetModel = vi.fn();
const mockGetClient = vi.fn();

vi.mock("@/shared/api/acpApi", () => ({
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mockGetClient(),
  getBackendClient: () => mockGetClient(),
}));

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
    ],
  },
};

describe("transitionSessionTarget with managed Goose models", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { resetSessionTargetCoordinatorsForTests } = await import(
      "./sessionTargetCoordinator"
    );
    resetSessionTargetCoordinatorsForTests();
    mockLoadSession.mockResolvedValue(undefined);
    mockSetProvider.mockResolvedValue(undefined);
    mockSetModel.mockResolvedValue(undefined);
    mockGetClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: ["goose-gpt-5-5", "goose-claude-opus-4-8"],
        }),
      },
    });
    const { resetManagedModelSelectionRepairCacheForTests } = await import(
      "@/features/providers/lib/managedModelSelectionRepair"
    );
    resetManagedModelSelectionRepairCacheForTests();

    const { useRuntimeConfigStore } = await import(
      "@/shared/runtime-config/runtimeConfigStore"
    );
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "appDefault",
        config: managedRuntimeConfig,
      },
      config: managedRuntimeConfig,
    });
  });

  it("repairs a legacy Databricks v1 model before preparing an existing session", async () => {
    const { useChatSessionStore } = await import(
      "@/features/chat/stores/chatSessionStore"
    );
    useChatSessionStore.setState({
      sessions: [
        {
          id: "legacy-session",
          title: "Legacy session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "goose",
            modelName: "goose",
          },
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const { transitionSessionTarget } = await import(
      "./sessionTargetCoordinator"
    );

    await expect(
      transitionSessionTarget({
        sessionId: "legacy-session",
        target: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose",
          modelName: "goose",
        },
        workingDir: "/tmp/project",
      }),
    ).resolves.toMatchObject({
      applied: true,
      resolvedTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-5",
        modelName: "goose-gpt-5-5",
      },
    });

    expect(mockSetProvider).toHaveBeenCalledWith(
      "legacy-session",
      "databricks_v2",
      { requestId: undefined },
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "legacy-session",
      "goose-gpt-5-5",
      { providerId: "databricks_v2", requestId: undefined },
    );
    expect(mockSetModel).not.toHaveBeenCalledWith("legacy-session", "goose");
  });

  it("commits a repaired target through the coordinator", async () => {
    const { useChatSessionStore } = await import(
      "@/features/chat/stores/chatSessionStore"
    );
    useChatSessionStore.setState({
      sessions: [
        {
          id: "ownership-session",
          title: "Ownership session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "goose",
            modelName: "goose",
          },
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const pendingModels = new Promise<{ models: string[] }>((resolve) => {
      queueMicrotask(() => {
        useChatSessionStore
          .getState()
          .replaceSessionExecutionTarget("ownership-session", {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "goose-claude-opus-4-8",
            modelName: "goose-claude-opus-4-8",
          });
        resolve({ models: ["goose-gpt-5-5"] });
      });
    });
    mockGetClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi
          .fn()
          .mockReturnValue(pendingModels),
      },
    });
    const { resetManagedModelSelectionRepairCacheForTests } = await import(
      "@/features/providers/lib/managedModelSelectionRepair"
    );
    resetManagedModelSelectionRepairCacheForTests();
    const { transitionSessionTarget } = await import(
      "./sessionTargetCoordinator"
    );

    await expect(
      transitionSessionTarget({
        sessionId: "ownership-session",
        target: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose",
          modelName: "goose",
        },
        workingDir: "/tmp/project",
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(
      useChatSessionStore.getState().getSession("ownership-session"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-5",
        modelName: "goose-gpt-5-5",
      },
    });
  });

  it("clears stale session model state when no managed default exists", async () => {
    const configWithoutDefault: RuntimeConfig = {
      ...managedRuntimeConfig,
      goose: {
        ...managedRuntimeConfig.goose,
        defaultModelId: undefined,
      },
    };
    const { useRuntimeConfigStore } = await import(
      "@/shared/runtime-config/runtimeConfigStore"
    );
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "appDefault",
        config: configWithoutDefault,
      },
      config: configWithoutDefault,
    });
    const { useChatSessionStore } = await import(
      "@/features/chat/stores/chatSessionStore"
    );
    useChatSessionStore.setState({
      sessions: [
        {
          id: "no-default-session",
          title: "No default session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "missing-model",
            modelName: "Missing model",
          },
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const { transitionSessionTarget } = await import(
      "./sessionTargetCoordinator"
    );

    await expect(
      transitionSessionTarget({
        sessionId: "no-default-session",
        target: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "missing-model",
          modelName: "Missing model",
        },
        workingDir: "/tmp/project",
      }),
    ).resolves.toMatchObject({
      applied: true,
      resolvedTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
      },
    });

    expect(mockSetModel).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("no-default-session"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
      },
    });
  });

  it("finishes on the explicitly selected model instead of the managed default", async () => {
    const { transitionSessionTarget } = await import(
      "./sessionTargetCoordinator"
    );

    await expect(
      transitionSessionTarget({
        sessionId: "managed-opus-session",
        target: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-claude-opus-4-8",
          modelName: "Claude Opus 4.8",
        },
        workingDir: "/tmp/project",
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(mockSetProvider).toHaveBeenCalledWith(
      "managed-opus-session",
      "databricks_v2",
      { requestId: undefined },
    );
    expect(mockSetModel).toHaveBeenCalledOnce();
    expect(mockSetModel).toHaveBeenCalledWith(
      "managed-opus-session",
      "goose-claude-opus-4-8",
      { providerId: "databricks_v2", requestId: undefined },
    );
  });
});
