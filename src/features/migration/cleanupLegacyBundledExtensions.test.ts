import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBackupGooseConfig = vi.fn();
const mockListExtensions = vi.fn();
const mockRemoveExtension = vi.fn();

vi.mock("./api/migration", () => ({
  backupGooseConfig: (...args: unknown[]) => mockBackupGooseConfig(...args),
}));

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: (...args: unknown[]) => mockListExtensions(...args),
  removeExtension: (...args: unknown[]) => mockRemoveExtension(...args),
}));

describe("cleanupLegacyBundledExtensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackupGooseConfig.mockResolvedValue({
      backedUp: true,
      sourcePath: "/home/test/.config/goose/config.yaml",
      backupPath: "/home/test/.config/goose/config.yaml.backup-cleanup",
    });
    mockRemoveExtension.mockResolvedValue(undefined);
  });

  it("removes only disabled stale bundled internal-era MCPs", async () => {
    mockListExtensions.mockResolvedValue([
      {
        type: "stdio",
        name: "Supabase",
        description: "",
        cmd: "uvx",
        args: [],
        config_key: "supabase",
        enabled: false,
        bundled: true,
      },
      {
        type: "stdio",
        name: "Block App Kit",
        description: "",
        cmd: "uvx",
        args: [],
        config_key: "blockappkit",
        enabled: false,
        bundled: true,
      },
      // Enabled legacy extensions may be in use; do not delete them.
      {
        type: "stdio",
        name: "Blockcell",
        description: "",
        cmd: "uvx",
        args: [],
        config_key: "blockcell",
        enabled: true,
        bundled: true,
      },
      // User-added extension; do not delete it even if the key is similar.
      {
        type: "stdio",
        name: "Supabase",
        description: "",
        cmd: "uvx",
        args: [],
        config_key: "supabase-custom",
        enabled: false,
      },
      // Company-managed OAuth extension; preserved defensively.
      {
        type: "stdio",
        name: "Figma",
        description: "",
        cmd: "npx",
        args: [],
        config_key: "figma",
        enabled: false,
        bundled: true,
      },
    ]);

    const { cleanupLegacyBundledExtensions } = await import(
      "./cleanupLegacyBundledExtensions"
    );
    const result = await cleanupLegacyBundledExtensions();

    expect(mockBackupGooseConfig).toHaveBeenCalledOnce();
    expect(mockRemoveExtension).toHaveBeenCalledWith("supabase");
    expect(mockRemoveExtension).toHaveBeenCalledWith("blockappkit");
    expect(mockRemoveExtension).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      removedExtensions: [
        { configKey: "supabase", name: "Supabase" },
        { configKey: "blockappkit", name: "Block App Kit" },
      ],
      backupPath: "/home/test/.config/goose/config.yaml.backup-cleanup",
    });
  });

  it("preserves excluded legacy entries that migration just disabled", async () => {
    mockListExtensions.mockResolvedValue([
      {
        type: "stdio",
        name: "Supabase",
        description: "",
        cmd: "uvx",
        args: [],
        config_key: "supabase",
        enabled: false,
        bundled: true,
      },
    ]);

    const { cleanupLegacyBundledExtensions } = await import(
      "./cleanupLegacyBundledExtensions"
    );
    const result = await cleanupLegacyBundledExtensions({
      excludeConfigKeys: ["supabase"],
    });

    expect(mockBackupGooseConfig).not.toHaveBeenCalled();
    expect(mockRemoveExtension).not.toHaveBeenCalled();
    expect(result).toEqual({ removedExtensions: [] });
  });

  it("does not back up config when no stale legacy entries are present", async () => {
    mockListExtensions.mockResolvedValue([
      {
        type: "stdio",
        name: "Context7",
        description: "",
        cmd: "npx",
        args: [],
        config_key: "context7",
        enabled: false,
      },
    ]);

    const { cleanupLegacyBundledExtensions } = await import(
      "./cleanupLegacyBundledExtensions"
    );
    const result = await cleanupLegacyBundledExtensions();

    expect(mockBackupGooseConfig).not.toHaveBeenCalled();
    expect(mockRemoveExtension).not.toHaveBeenCalled();
    expect(result).toEqual({ removedExtensions: [] });
  });
});
