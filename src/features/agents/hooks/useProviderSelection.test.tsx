import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../stores/agentStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderSelection } from "./useProviderSelection";

const mockReadyAgentIds = vi.hoisted(() => ({
  value: new Set<string>(["goose"]),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: mockReadyAgentIds.value,
    agentReadiness: new Map(),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("useProviderSelection", () => {
  beforeEach(() => {
    mockReadyAgentIds.value = new Set<string>(["goose"]);
    useProviderCatalogStore.getState().reset();
    useAgentStore.setState({ providers: [], selectedProvider: "goose" });
  });

  it("keeps a ready catalog provider as the stored value", () => {
    mockReadyAgentIds.value = new Set(["goose", "codex-acp"]);
    useAgentStore.setState({ selectedProvider: "codex-acp" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("codex-acp");
  });

  it("keeps a catalogued provider as the persisted preference", () => {
    mockReadyAgentIds.value = new Set(["goose"]);
    useAgentStore.setState({ selectedProvider: "codex-acp" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("codex-acp");
  });

  it("keeps goose as the persisted preference when another agent is ready", () => {
    mockReadyAgentIds.value = new Set(["codex-acp"]);
    useAgentStore.setState({ selectedProvider: "goose" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("goose");
  });

  it("falls an unknown provider back to goose once the catalog is loaded", () => {
    useAgentStore.setState({ selectedProvider: "ghost-provider" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("goose");
  });

  it("keeps an unknown provider while the catalog has not loaded", () => {
    useProviderCatalogStore.setState({ loaded: false });
    useAgentStore.setState({ selectedProvider: "ghost-provider" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("ghost-provider");
  });

  it("keeps goose as goose", () => {
    useAgentStore.setState({ selectedProvider: "goose" });

    const { result } = renderHook(() => useProviderSelection());

    expect(result.current.selectedProvider).toBe("goose");
  });
});
