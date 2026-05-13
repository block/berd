import { act, renderHook, waitFor } from "@testing-library/react";
import type { ProviderInventoryEntryDto } from "@aaif/goose-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";
import { useProviderInventoryStore } from "../stores/providerInventoryStore";
import { useAgentProviderStatus } from "./useAgentProviderStatus";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

const checkAgentInstalled = vi.fn();
const checkAgentAuth = vi.fn();
const getProviderInventory = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) => checkAgentInstalled(...args),
  checkAgentAuth: (...args: unknown[]) => checkAgentAuth(...args),
}));

vi.mock("@/features/providers/api/inventory", () => ({
  getProviderInventory: (...args: unknown[]) => getProviderInventory(...args),
}));

function inventoryEntry(
  overrides: Partial<ProviderInventoryEntryDto>,
): ProviderInventoryEntryDto {
  return {
    providerId: "claude-acp",
    providerName: "Claude",
    description: "",
    defaultModel: "",
    configured: true,
    providerType: "Claude",
    category: "agent",
    configKeys: [],
    setupSteps: [],
    supportsRefresh: true,
    refreshing: false,
    models: [],
    stale: false,
    ...overrides,
  };
}

const catalogEntries: ProviderCatalogEntry[] = [
  {
    id: "goose",
    displayName: "Goose",
    category: "agent",
    description: "Goose",
    setupMethod: "none",
    group: "default",
  },
  {
    id: "claude-acp",
    displayName: "Claude",
    category: "agent",
    description: "Claude",
    setupMethod: "cli_auth",
    binaryName: "claude-agent-acp",
    supportsAuth: true,
    supportsAuthStatus: true,
    group: "default",
  },
  {
    id: "amp-acp",
    displayName: "Amp",
    category: "agent",
    description: "Amp",
    setupMethod: "cli_auth",
    binaryName: "amp-acp",
    supportsAuth: false,
    supportsAuthStatus: false,
    group: "default",
  },
];

describe("useAgentProviderStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useProviderCatalogStore.getState().setEntries(catalogEntries);
    useProviderInventoryStore.getState().setEntries([]);
  });

  it("derives installed ready agents from inventory and gates auth-status providers", async () => {
    checkAgentAuth.mockResolvedValue(true);
    useProviderInventoryStore.getState().setEntries([
      inventoryEntry({ providerId: "claude-acp", configured: true }),
      inventoryEntry({
        providerId: "amp-acp",
        providerName: "Amp",
        providerType: "Amp",
        configured: true,
      }),
    ]);

    const { result } = renderHook(() => useAgentProviderStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.readyAgentIds.has("goose")).toBe(true);
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(true);
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(true);
    expect(checkAgentAuth).toHaveBeenCalledWith("claude-acp");
    expect(checkAgentInstalled).not.toHaveBeenCalled();
  });

  it("refreshes inventory and excludes agents that core still marks unconfigured", async () => {
    getProviderInventory.mockResolvedValue([
      inventoryEntry({ providerId: "claude-acp", configured: false }),
      inventoryEntry({
        providerId: "amp-acp",
        providerName: "Amp",
        providerType: "Amp",
        configured: true,
      }),
    ]);

    const { result } = renderHook(() => useAgentProviderStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(getProviderInventory).toHaveBeenCalledWith([
      "claude-acp",
      "amp-acp",
    ]);
    expect(result.current.readyAgentIds.has("goose")).toBe(true);
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(false);
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(true);
    expect(
      useProviderInventoryStore.getState().entries.get("claude-acp")
        ?.configured,
    ).toBe(false);
  });

  it("clears loading and rejects when refresh inventory fails", async () => {
    getProviderInventory.mockRejectedValue(new Error("inventory failed"));

    const { result } = renderHook(() => useAgentProviderStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.refresh();
      }),
    ).rejects.toThrow("inventory failed");

    expect(result.current.loading).toBe(false);
  });

  it("does not apply refresh readiness from an old catalog", async () => {
    let resolveInventory!: (entries: ProviderInventoryEntryDto[]) => void;
    getProviderInventory.mockReturnValue(
      new Promise<ProviderInventoryEntryDto[]>((resolve) => {
        resolveInventory = resolve;
      }),
    );
    useProviderInventoryStore
      .getState()
      .setEntries([
        inventoryEntry({ providerId: "claude-acp", configured: true }),
      ]);

    const { result } = renderHook(() => useAgentProviderStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(true);

    const refreshPromise = act(async () => {
      await result.current.refresh();
    });
    useProviderCatalogStore.getState().setEntries([catalogEntries[0]]);
    await act(async () => {
      await Promise.resolve();
    });

    resolveInventory([
      inventoryEntry({ providerId: "claude-acp", configured: true }),
      inventoryEntry({
        providerId: "amp-acp",
        providerName: "Amp",
        providerType: "Amp",
        configured: true,
      }),
    ]);
    await refreshPromise;

    expect(result.current.readyAgentIds.has("goose")).toBe(true);
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(false);
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(false);
  });
});
