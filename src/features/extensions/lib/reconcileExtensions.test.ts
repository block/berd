import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionEntry } from "../types";
import { reconcileExtensions } from "./reconcileExtensions";

const { listExtensions, toggleExtension, removeExtension, backupGooseConfig } =
  vi.hoisted(() => ({
    listExtensions: vi.fn(),
    toggleExtension: vi.fn(),
    removeExtension: vi.fn(),
    backupGooseConfig: vi.fn(),
  }));
vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions,
  toggleExtension,
  removeExtension,
}));
vi.mock("@/features/migration/api/migration", () => ({ backupGooseConfig }));

const legacy: ExtensionEntry = {
  type: "stdio",
  config_key: "salesforce-sq",
  name: "Salesforce (Square)",
  description: "",
  cmd: "uvx",
  args: ["mcp_salesforce_sq@0.2.4"],
  bundled: true,
  enabled: true,
};

describe("startup extension reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    backupGooseConfig.mockResolvedValue({
      backedUp: true,
      backupPath: "/config.yaml.backup",
    });
    removeExtension.mockResolvedValue(undefined);
    toggleExtension.mockResolvedValue(undefined);
  });

  it.each([
    true,
    false,
  ])("retires the bundled stdio Salesforce MCP when enabled=%s, including after onboarding", async (enabled) => {
    listExtensions.mockResolvedValue([{ ...legacy, enabled }]);
    await reconcileExtensions();
    expect(backupGooseConfig).toHaveBeenCalledOnce();
    expect(removeExtension).toHaveBeenCalledWith("salesforce-sq");
    expect(backupGooseConfig.mock.invocationCallOrder[0]).toBeLessThan(
      removeExtension.mock.invocationCallOrder[0],
    );
  });

  it("recognizes uvx paths and normalized package names", async () => {
    listExtensions.mockResolvedValue([
      { ...legacy, cmd: "/usr/local/bin/uvx", args: ["mcp-salesforce-sq"] },
    ]);
    await reconcileExtensions();
    expect(removeExtension).toHaveBeenCalledWith("salesforce-sq");
  });

  it("preserves user-owned, remote, credential-configured, and unrelated servers", async () => {
    listExtensions.mockResolvedValue([
      { ...legacy, bundled: false },
      { ...legacy, bundled: undefined },
      { ...legacy, type: "streamable_http", uri: "https://example.com/mcp" },
      { ...legacy, envs: { SALESFORCE_TOKEN: "configured" } },
      { ...legacy, env_keys: ["SALESFORCE_TOKEN"] },
      { ...legacy, cmd: "custom-wrapper" },
      { ...legacy, args: ["mcp_salesforce_sq_custom"] },
      { ...legacy, args: ["mcp_salesforce_sq@git+https://example.com/custom"] },
      { ...legacy, args: ["mcp_salesforce_sq", "--custom"] },
    ]);
    await reconcileExtensions();
    expect(backupGooseConfig).not.toHaveBeenCalled();
    expect(removeExtension).not.toHaveBeenCalled();
  });

  it("enables core tools while retiring Salesforce and becomes a no-op on the next boot", async () => {
    listExtensions
      .mockResolvedValueOnce([
        legacy,
        {
          type: "builtin",
          name: "skills",
          description: "",
          config_key: "skills",
          enabled: false,
        },
        {
          type: "builtin",
          name: "developer",
          description: "",
          config_key: "developer",
          enabled: true,
        },
      ])
      .mockResolvedValueOnce([]);
    await reconcileExtensions();
    await reconcileExtensions();
    expect(toggleExtension).toHaveBeenCalledExactlyOnceWith("skills", true);
    expect(removeExtension).toHaveBeenCalledOnce();
    expect(backupGooseConfig).toHaveBeenCalledOnce();
  });

  it("does not remove anything if the backup fails", async () => {
    listExtensions.mockResolvedValue([legacy]);
    backupGooseConfig.mockRejectedValue(new Error("backup failed"));
    await expect(reconcileExtensions()).rejects.toThrow("backup failed");
    expect(removeExtension).not.toHaveBeenCalled();
  });
});
