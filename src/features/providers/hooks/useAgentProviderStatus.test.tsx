import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";
import { useAgentProviderStatus } from "./useAgentProviderStatus";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

const checkAgentInstalled = vi.fn();
const checkAgentAuth = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) => checkAgentInstalled(...args),
  checkAgentAuth: (...args: unknown[]) => checkAgentAuth(...args),
}));

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
    checkAgentInstalled.mockResolvedValue(true);
    checkAgentAuth.mockResolvedValue(true);
  });

  it("derives ready agents from local install and auth checks", async () => {
    const { result } = renderHook(() => useAgentProviderStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.readyAgentIds.has("goose")).toBe(true);
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(true);
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(true);
    expect(checkAgentInstalled).toHaveBeenCalledWith("claude-acp");
    expect(checkAgentInstalled).toHaveBeenCalledWith("amp-acp");
    expect(checkAgentAuth).toHaveBeenCalledWith("claude-acp");
  });

  it("excludes agents that are not installed", async () => {
    checkAgentInstalled.mockImplementation((providerId: string) =>
      Promise.resolve(providerId !== "claude-acp"),
    );

    const { result } = renderHook(() => useAgentProviderStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.readyAgentIds.has("goose")).toBe(true);
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(false);
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(true);
  });

  it("uses the auth hint for providers without auth status support", async () => {
    useProviderCatalogStore.getState().setEntries([
      ...catalogEntries,
      {
        id: "codex-acp",
        displayName: "Codex",
        category: "agent",
        description: "Codex",
        setupMethod: "cli_auth",
        binaryName: "codex-acp",
        supportsAuth: true,
        supportsAuthStatus: false,
        group: "default",
      },
    ]);
    localStorage.setItem("agent-provider-auth:codex-acp", "true");

    const { result } = renderHook(() => useAgentProviderStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.readyAgentIds.has("codex-acp")).toBe(true);
    expect(checkAgentAuth).not.toHaveBeenCalledWith("codex-acp");
  });

  it("refreshes readiness from the current catalog", async () => {
    checkAgentInstalled.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { result } = renderHook(() => useAgentProviderStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.readyAgentIds.has("claude-acp")).toBe(true);
  });

  it("does not apply refresh readiness from an old catalog", async () => {
    let resolveInstalled!: (installed: boolean) => void;
    checkAgentInstalled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInstalled = resolve;
      }),
    );

    const { result } = renderHook(() => useAgentProviderStatus());
    useProviderCatalogStore.getState().setEntries([catalogEntries[0]]);
    await act(async () => {
      resolveInstalled(true);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readyAgentIds.has("goose")).toBe(true);
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(false);
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(false);
  });
});
