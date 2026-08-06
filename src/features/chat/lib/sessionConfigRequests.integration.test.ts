import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";

const mockLoadSession = vi.fn();
const mockSetProvider = vi.fn();
const mockSetModel = vi.fn();

vi.mock("@/shared/api/acpApi", () => ({
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
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
