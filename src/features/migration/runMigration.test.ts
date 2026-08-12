import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGooseOnboardingImportScan = vi.fn();
const mockGooseOnboardingImportApply = vi.fn();
const mockGooseDefaultsSave = vi.fn();
const mockGooseConfigExtensionsToggle = vi.fn();
const mockListExtensions = vi.fn();
const mockGetStoredModelPreference = vi.fn();
const mockSetStoredModelPreference = vi.fn();
const mockSetSelectedProvider = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableOnboardingImportScan: (...args: unknown[]) =>
        mockGooseOnboardingImportScan(...args),
      GooseUnstableOnboardingImportApply: (...args: unknown[]) =>
        mockGooseOnboardingImportApply(...args),
      GooseUnstableDefaultsSave: (...args: unknown[]) =>
        mockGooseDefaultsSave(...args),
      GooseUnstableConfigExtensionsToggle: (...args: unknown[]) =>
        mockGooseConfigExtensionsToggle(...args),
    },
  }),
}));

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: (...args: unknown[]) => mockListExtensions(...args),
  toggleExtension: (configKey: string, enabled: boolean) =>
    mockGooseConfigExtensionsToggle({ configKey, enabled }),
}));

vi.mock("@/features/chat/lib/modelPreferences", () => ({
  getStoredModelPreference: (...args: unknown[]) =>
    mockGetStoredModelPreference(...args),
  setStoredModelPreference: (...args: unknown[]) =>
    mockSetStoredModelPreference(...args),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      setSelectedProvider: (...args: unknown[]) =>
        mockSetSelectedProvider(...args),
    }),
  },
}));

vi.mock("@/features/runtime-config/defaults", () => ({
  getDefaultGooseModelProviderId: () => "databricks_v2",
  getDefaultGooseModelId: () => "goose-gpt-5-5",
  getDefaultGooseModelName: () => "GPT-5.5",
}));

const mockedInvoke = vi.mocked(invoke);

describe("runMigration", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedInvoke.mockReset();
    mockGetStoredModelPreference.mockReturnValue(null);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Default: backup_goose_config returns a backup path.
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "backup_goose_config") {
        return {
          backedUp: true,
          sourcePath: "/home/test/.config/goose/config.yaml",
          backupPath:
            "/home/test/.config/goose/config.yaml.backup-2026-05-19T12-00-00Z",
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    mockGooseOnboardingImportScan.mockResolvedValue({ candidates: [] });
    mockGooseOnboardingImportApply.mockResolvedValue(undefined);
    mockGooseDefaultsSave.mockResolvedValue(undefined);
    mockGooseConfigExtensionsToggle.mockResolvedValue(undefined);
    mockListExtensions.mockResolvedValue([]);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("runs backup before issuing the ACP import scan", async () => {
    mockGooseOnboardingImportScan.mockResolvedValue({
      candidates: [{ id: "cand-1" }],
    });

    const { runMigration } = await import("./runMigration");
    await runMigration();

    expect(mockedInvoke).toHaveBeenCalledWith("backup_goose_config");
    const backupOrder = mockedInvoke.mock.invocationCallOrder[0];
    const importScanOrder =
      mockGooseOnboardingImportScan.mock.invocationCallOrder[0];
    const importApplyOrder =
      mockGooseOnboardingImportApply.mock.invocationCallOrder[0];

    expect(backupOrder).toBeDefined();
    expect(importScanOrder).toBeDefined();
    expect(importApplyOrder).toBeDefined();
    expect(backupOrder).toBeLessThan(importScanOrder);
    expect(backupOrder).toBeLessThan(importApplyOrder);
  });

  it("skips import apply when there are no candidates", async () => {
    mockGooseOnboardingImportScan.mockResolvedValue({ candidates: [] });

    const { runMigration } = await import("./runMigration");
    await runMigration();

    expect(mockGooseOnboardingImportApply).not.toHaveBeenCalled();
  });

  it("toggles every extension whose config_key is not in KEEP_ENABLED", async () => {
    mockListExtensions.mockResolvedValue([
      // Kept by default — should not be toggled.
      {
        type: "builtin",
        name: "developer",
        display_name: "Developer",
        description: "",
        config_key: "developer",
        enabled: true,
      },
      {
        type: "builtin",
        name: "skills",
        display_name: "Skills",
        description: "",
        config_key: "skills",
        enabled: true,
      },
      {
        type: "builtin",
        name: "summon",
        display_name: "Summon",
        description: "",
        config_key: "summon",
        enabled: true,
      },
      // Imported, not in keep list — should be toggled off.
      {
        type: "stdio",
        name: "github",
        description: "",
        cmd: "npx",
        args: [],
        config_key: "github",
        enabled: true,
      },
      {
        type: "platform",
        name: "summarize",
        display_name: "Summarize",
        description: "",
        config_key: "summarize",
        enabled: true,
      },
      // Already disabled — skip silently (still not in the banner list).
      {
        type: "stdio",
        name: "slack",
        description: "",
        cmd: "npx",
        args: [],
        config_key: "slack",
        enabled: false,
      },
    ]);

    const { runMigration } = await import("./runMigration");
    const result = await runMigration();

    const toggledKeys = mockGooseConfigExtensionsToggle.mock.calls.map(
      ([arg]) => (arg as { configKey: string }).configKey,
    );
    expect(toggledKeys).toEqual(["github", "summarize"]);
    for (const [arg] of mockGooseConfigExtensionsToggle.mock.calls) {
      expect(arg).toMatchObject({ enabled: false });
    }
    expect(result.disabledExtensions).toEqual([
      { configKey: "github", name: "github" },
      { configKey: "summarize", name: "Summarize" },
    ]);
    expect(result.backupPath).toBe(
      "/home/test/.config/goose/config.yaml.backup-2026-05-19T12-00-00Z",
    );
  });

  it("returns the collected disabled extensions and backup path for mark_migration_complete", async () => {
    mockListExtensions.mockResolvedValue([
      {
        type: "stdio",
        name: "github",
        description: "",
        cmd: "npx",
        args: [],
        config_key: "github",
        enabled: true,
      },
    ]);

    const { runMigration } = await import("./runMigration");
    const result = await runMigration();

    // The orchestrator hands these to the caller, which is what
    // `mark_migration_complete` is invoked with by `useMigrationGate`.
    expect(result).toEqual({
      disabledExtensions: [{ configKey: "github", name: "github" }],
      backupPath:
        "/home/test/.config/goose/config.yaml.backup-2026-05-19T12-00-00Z",
    });
  });

  it("saves the configured Databricks default model and seeds the frontend preference", async () => {
    // Locks in the shape sent to `_goose/unstable/defaults/save` and the per-agent
    // preference. If the shipped runtime default changes, this test should
    // change with it.
    const { runMigration } = await import("./runMigration");
    await runMigration();

    expect(mockGooseDefaultsSave).toHaveBeenCalledWith({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
    expect(mockSetStoredModelPreference).toHaveBeenCalledWith("goose", {
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
      modelName: "GPT-5.5",
    });
    expect(mockSetSelectedProvider).toHaveBeenCalledWith("goose");
  });

  it("does not overwrite an existing frontend model preference", async () => {
    mockGetStoredModelPreference.mockReturnValueOnce({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });

    const { runMigration } = await import("./runMigration");
    await runMigration();

    expect(mockSetStoredModelPreference).not.toHaveBeenCalled();
  });

  it("continues when saving the backend default model fails", async () => {
    const invalidParams = Object.assign(new Error("Invalid params"), {
      code: -32602,
    });
    mockGooseDefaultsSave.mockRejectedValueOnce(invalidParams);

    const { runMigration } = await import("./runMigration");
    const result = await runMigration();

    expect(mockGooseDefaultsSave).toHaveBeenCalledTimes(1);
    expect(mockSetStoredModelPreference).toHaveBeenCalledWith("goose", {
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
      modelName: "GPT-5.5",
    });
    expect(mockSetSelectedProvider).toHaveBeenCalledWith("goose");
    expect(result.disabledExtensions).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to save migrated default model:",
      invalidParams,
    );
  });

  it("returns an undefined backup path when no config was present to back up", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "backup_goose_config") {
        return {
          backedUp: false,
          sourcePath: "/home/test/.config/goose/config.yaml",
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { runMigration } = await import("./runMigration");
    const result = await runMigration();

    expect(result.backupPath).toBeUndefined();
    expect(result.disabledExtensions).toEqual([]);
  });
});
