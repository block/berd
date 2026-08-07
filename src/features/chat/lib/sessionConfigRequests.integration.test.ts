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

describe("applyLatestSessionConfig with managed Goose models", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
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
          providerId: "databricks_v2",
          modelId: "goose",
          modelName: "goose",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const { applyLatestSessionConfig } = await import(
      "./sessionConfigRequests"
    );

    await expect(
      applyLatestSessionConfig({
        sessionId: "legacy-session",
        providerId: "databricks_v2",
        workingDir: "/tmp/project",
        modelId: "goose",
      }),
    ).resolves.toMatchObject({
      applied: true,
      repaired: true,
      resolvedProviderId: "databricks_v2",
      resolvedModelId: "goose-gpt-5-5",
    });

    expect(mockSetProvider).toHaveBeenCalledWith(
      "legacy-session",
      "databricks_v2",
    );
    expect(mockSetModel).toHaveBeenCalledWith(
      "legacy-session",
      "goose-gpt-5-5",
    );
    expect(mockSetModel).not.toHaveBeenCalledWith("legacy-session", "goose");
    expect(
      useChatSessionStore.getState().getSession("legacy-session"),
    ).toMatchObject({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
      modelName: "goose-gpt-5-5",
    });
  });

  it("does not persist an older repair after a newer model intent takes ownership", async () => {
    const { useChatSessionStore } = await import(
      "@/features/chat/stores/chatSessionStore"
    );
    useChatSessionStore.setState({
      sessions: [
        {
          id: "ownership-session",
          title: "Ownership session",
          providerId: "databricks_v2",
          modelId: "goose",
          modelName: "goose",
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
          .beginModelSelectionIntent("ownership-session", {
            requestId: "newer-selection",
            kind: "model",
            providerId: "databricks_v2",
            modelId: "goose-claude-opus-4-8",
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
    const { applyLatestSessionConfig } = await import(
      "./sessionConfigRequests"
    );

    await expect(
      applyLatestSessionConfig({
        sessionId: "ownership-session",
        providerId: "databricks_v2",
        workingDir: "/tmp/project",
        modelId: "goose",
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(
      useChatSessionStore.getState().getSession("ownership-session"),
    ).toMatchObject({
      providerId: "databricks_v2",
      modelId: "goose",
      modelName: "goose",
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
          providerId: "databricks_v2",
          modelId: "missing-model",
          modelName: "Missing model",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const { applyLatestSessionConfig } = await import(
      "./sessionConfigRequests"
    );

    await expect(
      applyLatestSessionConfig({
        sessionId: "no-default-session",
        providerId: "databricks_v2",
        workingDir: "/tmp/project",
        modelId: "missing-model",
      }),
    ).resolves.toMatchObject({
      applied: true,
      repaired: true,
      resolvedProviderId: "databricks_v2",
      resolvedModelId: undefined,
    });

    expect(mockSetModel).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("no-default-session"),
    ).toMatchObject({
      providerId: "databricks_v2",
      modelId: undefined,
      modelName: undefined,
    });
  });

  it("finishes on the explicitly selected model instead of the managed default", async () => {
    const { applyLatestSessionConfig } = await import(
      "./sessionConfigRequests"
    );

    await expect(
      applyLatestSessionConfig({
        sessionId: "managed-opus-session",
        providerId: "goose",
        workingDir: "/tmp/project",
        modelId: "goose-claude-opus-4-8",
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(mockSetProvider).toHaveBeenCalledWith(
      "managed-opus-session",
      "databricks_v2",
    );
    expect(mockSetModel.mock.calls).toEqual([
      ["managed-opus-session", "goose-claude-opus-4-8"],
    ]);
    expect(mockSetModel.mock.calls.at(-1)).toEqual([
      "managed-opus-session",
      "goose-claude-opus-4-8",
    ]);
  });
});
