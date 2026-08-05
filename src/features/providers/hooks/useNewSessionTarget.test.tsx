import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { checkAllProviderStatus } from "../api/credentials";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";
import { useDefaultProviderReadinessStore } from "../stores/defaultProviderReadinessStore";
import { useProviderModelCacheStore } from "../stores/providerModelCacheStore";
import { useNewSessionTarget } from "./useNewSessionTarget";

const mockAgentStatus = vi.hoisted(() => ({
  agentReadiness: new Map<string, "ready" | "not_ready">(),
  loading: false,
  refresh: vi.fn(),
}));

vi.mock("./useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => mockAgentStatus,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
vi.mock("@/features/settings/lib/settingsEvents", () => ({
  requestOpenSettings: vi.fn(),
}));
vi.mock("../api/credentials", () => ({
  checkAllProviderStatus: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => ({ byoKeyProviders: false }),
}));

describe("useNewSessionTarget", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockAgentStatus.agentReadiness = new Map([["goose", "ready"]]);
    mockAgentStatus.loading = false;
    mockAgentStatus.refresh.mockReset();
    useAgentStore.setState({ selectedProvider: "anthropic" });
    useProviderCatalogStore.getState().reset();
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "anthropic",
          {
            providerId: "anthropic",
            models: [
              {
                id: "claude-sonnet-4",
                name: "Claude Sonnet 4",
                providerId: "anthropic",
              },
            ],
            fetchedAt: Date.now(),
          },
        ],
      ]),
      refreshingProviderIds: new Set(),
    });
  });

  it("keeps a concrete model preference on the Goose harness", async () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "claude-sonnet-4",
          modelName: "Claude Sonnet 4",
          providerId: "anthropic",
        },
      }),
    );

    const { result } = renderHook(() => useNewSessionTarget());
    let target: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      target = await result.current();
    });

    expect(target).toMatchObject({
      status: "ready",
      provenance: "persisted",
      providerId: "goose",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });

  it("drops an unavailable stored model before resolving the new chat", async () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "removed-model",
          modelName: "Removed model",
          providerId: "anthropic",
        },
      }),
    );

    const { result } = renderHook(() => useNewSessionTarget());
    let target: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      target = await result.current();
    });

    expect(target).toMatchObject({
      status: "ready",
      providerId: "goose",
      modelId: "goose-gpt-5-5",
    });
  });

  it("drops a stored model whose provider was disconnected and falls back to the Goose default", async () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "claude-sonnet-4",
          modelName: "Claude Sonnet 4",
          providerId: "anthropic",
        },
      }),
    );
    // Disconnecting a provider removes its model-cache entry entirely.
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
    });
    vi.mocked(checkAllProviderStatus).mockResolvedValue([
      { providerId: "anthropic", isConfigured: false },
    ]);

    const { result } = renderHook(() => useNewSessionTarget());
    let target: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      target = await result.current();
    });

    expect(target).toMatchObject({
      status: "ready",
      providerId: "goose",
      modelId: "goose-gpt-5-5",
    });
  });
});
