import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyRuntimeProviderConfig } from "@/features/providers/runtimeProviderConfig";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
  type RuntimeConfigLoadResult,
  type RuntimeGooseModelProvider,
} from "./schema";
import { useRuntimeConfigStore } from "./runtimeConfigStore";
import { refreshRuntimeConfigForNewChat } from "./newChatRuntimeConfig";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), getClient: vi.fn() }));
vi.mock("@/shared/api/runtimeConfig", () => ({
  refreshRuntimeConfigForNewChat: () => mocks.refresh(),
}));
vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mocks.getClient(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(id: string, apiUrl: string): RuntimeGooseModelProvider {
  return {
    id,
    displayName: id,
    models: [{ id: `${id}-model`, name: id }],
    customProvider: {
      providerId: id,
      displayName: id,
      engine: "openai_compatible",
      apiUrl,
      requiresAuth: false,
      models: [`${id}-model`],
    },
  };
}
function config(...providers: RuntimeGooseModelProvider[]): RuntimeConfig {
  return { ...DEFAULT_RUNTIME_CONFIG, goose: { modelProviders: providers } };
}
function ready(value: RuntimeConfig): RuntimeConfigLoadResult {
  return { status: "ready", source: "fakeEndpoint", config: value };
}
function backendResponse(value: RuntimeGooseModelProvider) {
  return { provider: { ...value.customProvider, catalogProviderId: value.id } };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRuntimeConfigStore.getState().setResult(ready(config()));
  useProviderCatalogStore.getState().reset();
  useProviderModelCacheStore.setState({
    providers: new Map(),
    runtimeManagedProviderIds: new Set(),
  });
});

describe("new-chat provider reconciliation", () => {
  it("shares refresh and waits for changed endpoint and new provider before target resolution", async () => {
    const oldProvider = provider("custom_old", "https://old.example/v1");
    const changed = provider("custom_old", "https://fresh.example/v1");
    const added = provider("custom_added", "https://added.example/v1");
    const refresh = deferred<RuntimeConfigLoadResult>();
    const update = deferred<void>();
    mocks.refresh.mockReturnValue(refresh.promise);
    const read = vi.fn().mockImplementation(async ({ providerId }) => {
      if (providerId === oldProvider.id) return backendResponse(oldProvider);
      throw new Error("Unknown provider");
    });
    const write = vi.fn().mockReturnValue(update.promise);
    const create = vi.fn().mockResolvedValue({ providerId: added.id });
    mocks.getClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersCustomRead: read,
        GooseUnstableProvidersCustomUpdate: write,
        GooseUnstableProvidersCustomCreate: create,
      },
    });
    const first = refreshRuntimeConfigForNewChat();
    expect(refreshRuntimeConfigForNewChat()).toBe(first);
    const resolveTarget = vi.fn();
    void first.then(resolveTarget);
    expect(read).not.toHaveBeenCalled();
    refresh.resolve(ready(config(changed, added)));
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(refreshRuntimeConfigForNewChat()).toBe(first);
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(
      useProviderCatalogStore
        .getState()
        .entries.find((entry) => entry.id === added.id),
    ).toBeUndefined();
    update.resolve();
    await first;
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: changed.id,
        apiUrl: changed.customProvider?.apiUrl,
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogProviderId: added.id,
        apiUrl: added.customProvider?.apiUrl,
      }),
    );
    expect(
      useProviderCatalogStore.getState().entries.map((entry) => entry.id),
    ).toContain(added.id);
    expect(
      useProviderModelCacheStore.getState().providers.get(added.id)?.models[0]
        ?.id,
    ).toBe(`${added.id}-model`);
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("keeps unchanged custom providers read-only across Auto-only changes", async () => {
    const existing = provider("custom", "https://existing.example/v1");
    const read = vi.fn().mockResolvedValue(backendResponse(existing));
    const update = vi.fn();
    const create = vi.fn();
    const sessionOperation = vi.fn(() => {
      throw new Error("must not reconfigure or restart sessions");
    });
    mocks.getClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersCustomRead: read,
        GooseUnstableProvidersCustomUpdate: update,
        GooseUnstableProvidersCustomCreate: create,
      },
      sessions: new Proxy({}, { get: () => sessionOperation }),
    });
    const withAuto = (url: string): RuntimeConfig => ({
      ...config(existing),
      goose: {
        ...config(existing).goose,
        autoRouting: {
          url,
          defaultModeId: "auto",
          modes: [
            {
              id: "auto",
              displayName: "Auto",
              modelProviderId: existing.id,
              fallback: { modelId: `${existing.id}-model`, effort: "medium" },
              models: [
                { modelId: `${existing.id}-model`, routerModel: "router" },
              ],
            },
          ],
        },
      },
    });
    mocks.refresh
      .mockResolvedValueOnce(ready(withAuto("https://router.example/old")))
      .mockResolvedValueOnce(ready(withAuto("https://router.example/new")));
    await refreshRuntimeConfigForNewChat();
    await refreshRuntimeConfigForNewChat();
    expect(read).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(sessionOperation).not.toHaveBeenCalled();
    expect(useRuntimeConfigStore.getState().config.goose.autoRouting?.url).toBe(
      "https://router.example/new",
    );
  });

  it("skips an obsolete read's write and publishes only the newest settings config", async () => {
    const old = provider("custom", "https://old.example/v1");
    const intermediate = provider("custom", "https://intermediate.example/v1");
    const latest = provider("custom", "https://latest.example/v1");
    let backend = old;
    const blockedRead = deferred<ReturnType<typeof backendResponse>>();
    const read = vi
      .fn()
      .mockImplementationOnce(() => blockedRead.promise)
      .mockImplementation(async () => backendResponse(backend));
    const write = vi.fn().mockImplementation(async () => {
      backend = latest;
    });
    mocks.getClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersCustomRead: read,
        GooseUnstableProvidersCustomUpdate: write,
      },
    });
    mocks.refresh.mockResolvedValue(ready(config(intermediate)));
    const creation = refreshRuntimeConfigForNewChat();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const latestConfig = config(latest);
    useRuntimeConfigStore.getState().setResult(ready(latestConfig));
    const settings = applyRuntimeProviderConfig(latestConfig, {
      requireBackendSync: true,
    });
    blockedRead.resolve(backendResponse(old));
    await Promise.all([creation, settings]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: latest.customProvider?.apiUrl }),
    );
    expect((await creation).status).toBe("ready");
    expect(useRuntimeConfigStore.getState().config).toBe(latestConfig);
  });

  it("serializes an already-sent older write before applying the current config", async () => {
    const old = provider("custom", "https://old.example/v1");
    const intermediate = provider("custom", "https://intermediate.example/v1");
    const latest = provider("custom", "https://latest.example/v1");
    let backend = old;
    const releaseWrite = deferred<void>();
    const read = vi
      .fn()
      .mockImplementation(async () => backendResponse(backend));
    const write = vi
      .fn()
      .mockImplementationOnce(async () => {
        await releaseWrite.promise;
        backend = intermediate;
      })
      .mockImplementation(async () => {
        backend = latest;
      });
    mocks.getClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersCustomRead: read,
        GooseUnstableProvidersCustomUpdate: write,
      },
    });
    mocks.refresh.mockResolvedValue(ready(config(intermediate)));
    const creation = refreshRuntimeConfigForNewChat();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const latestConfig = config(latest);
    useRuntimeConfigStore.getState().setResult(ready(latestConfig));
    const settings = applyRuntimeProviderConfig(latestConfig, {
      requireBackendSync: true,
    });
    const resolved = vi.fn();
    void creation.then(resolved);
    expect(read).toHaveBeenCalledTimes(1);
    expect(resolved).not.toHaveBeenCalled();
    releaseWrite.resolve();
    await Promise.all([creation, settings]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(backend).toBe(latest);
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("does not let a superseding best-effort apply hide backend failure from a waiting creator", async () => {
    const desired = provider("custom", "https://desired.example/v1");
    const blockedRead = deferred<ReturnType<typeof backendResponse>>();
    const read = vi
      .fn()
      .mockImplementationOnce(() => blockedRead.promise)
      .mockRejectedValue(new Error("latest sync failed"));
    mocks.getClient.mockResolvedValue({
      goose: { GooseUnstableProvidersCustomRead: read },
    });
    const runtimeConfig = config(desired);
    mocks.refresh.mockResolvedValue(ready(runtimeConfig));
    const creation = refreshRuntimeConfigForNewChat();
    const rejected = expect(creation).rejects.toThrow("latest sync failed");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const startup = applyRuntimeProviderConfig(runtimeConfig);
    blockedRead.resolve(backendResponse(desired));
    await startup;
    await rejected;
  });

  it("rejects failed provider reconciliation without publishing unusable targets and retries next creation", async () => {
    const added = provider("custom_added", "https://added.example/v1");
    mocks.refresh.mockResolvedValue(ready(config(added)));
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("ACP unavailable"))
      .mockResolvedValue(backendResponse(added));
    mocks.getClient.mockResolvedValue({
      goose: { GooseUnstableProvidersCustomRead: read },
    });
    await expect(refreshRuntimeConfigForNewChat()).rejects.toThrow(
      "ACP unavailable",
    );
    expect(
      useProviderCatalogStore
        .getState()
        .entries.find((entry) => entry.id === added.id),
    ).toBeUndefined();
    await refreshRuntimeConfigForNewChat();
    expect(
      useProviderCatalogStore.getState().entries.map((entry) => entry.id),
    ).toContain(added.id);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
});
