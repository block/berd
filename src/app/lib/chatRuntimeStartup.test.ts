import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadPersistedMessageQueues = vi.hoisted(() =>
  vi.fn<() => Promise<Record<string, never[]>>>(),
);
const mockGetClient = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockRefreshAllModelProviders = vi.hoisted(() => vi.fn());
const mockGetModelCacheRefreshProviderIds = vi.hoisted(() => vi.fn());
const mockIsModelInventoryAuthoritative = vi.hoisted(() => vi.fn());
const mockPersonaTargetMigration = vi.hoisted(() => vi.fn());
const mockAgentState = vi.hoisted(() => ({
  personas: [] as Array<{ id: string; writable: boolean }>,
  providers: [] as unknown[],
}));
const mockProviderModelState = vi.hoisted(() => ({
  providers: new Map<
    string,
    { models: Array<Record<string, unknown>>; error?: string }
  >(),
  runtimeManagedProviderIds: new Set<string>(),
}));

// The latch under test wraps startChatRuntime, whose body touches most of the
// startup module graph. Everything it reaches is stubbed inert (resolved,
// no-op, feature gates off) so each test controls the run's outcome through
// getClient — the realistic startup failure point — and counts runs via
// loadPersistedMessageQueues, the first call every run makes.

vi.mock("@/features/agents/lib/personaExecutionTarget", () => ({
  personaTargetMigration: mockPersonaTargetMigration,
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      ...mockAgentState,
      setProviders: () => {},
      setPersonas: () => {},
      setPersonasLoading: () => {},
      updatePersona: () => {},
    }),
  },
}));

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: {
    getState: () => ({ replaceQueuedMessages: () => {} }),
  },
}));

vi.mock("@/features/chat/stores/queuePersistence", () => ({
  loadPersistedMessageQueues: mockLoadPersistedMessageQueues,
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: {
    getState: () => ({ loadSessions: async () => {} }),
  },
}));

vi.mock("@/features/providers/curatedProviders", () => ({
  getCuratedAgentProviders: () => [],
}));

vi.mock("@/features/providers/runtimeProviderConstraints", () => ({
  hasAllowedModelProvider: () => true,
  parseProviderAllowlist: () => null,
}));

vi.mock("@/features/providers/modelCacheRefresh", () => ({
  getModelCacheRefreshProviderIds: mockGetModelCacheRefreshProviderIds,
}));

vi.mock("@/features/providers/providerCatalog", () => ({
  getModelProviders: () => [],
  getProviderCatalog: () => [],
}));

vi.mock("@/features/providers/runtimeProviderConfig", () => ({
  applyRuntimeProviderConfig: async () => {},
  defaultModelInventoryModeForLoadResult: () => "default",
}));

vi.mock("@/features/providers/api/catalog", () => ({
  listProviderSetupCatalog: async () => [],
  selectSetupCatalogModelProviders: () => [],
  selectDatabricksHostConfigProvider: () => undefined,
}));

vi.mock("@/features/providers/stores/agentSetupStore", () => ({
  useAgentSetupStore: {
    getState: () => ({ init: async () => {} }),
  },
}));

vi.mock("@/features/providers/stores/modelSetupStore", () => ({
  useModelSetupStore: {
    getState: () => ({ init: async () => {} }),
  },
}));

vi.mock("@/features/providers/stores/providerCatalogStore", () => ({
  useProviderCatalogStore: {
    getState: () => ({ mergeEntries: () => {} }),
  },
}));

vi.mock("@/features/providers/defaultProviderConfig", () => ({
  getModelDiscoveryProviderIds: async () => [],
  reconcileManagedDefaultProviderSelection: async () => {},
  saveDefaultProviderSelectionFromConfiguredProvider: async () => {},
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: async () => [],
}));

vi.mock("@/features/providers/stores/defaultProviderReadinessStore", () => ({
  useDefaultProviderReadinessStore: {
    getState: () => ({
      refresh: async () => ({
        status: "ready",
        providerId: "goose",
        modelId: "model",
      }),
    }),
  },
}));

vi.mock("@/features/providers/stores/providerModelCacheStore", () => ({
  useProviderModelCacheStore: {
    getState: () => ({
      ...mockProviderModelState,
      loadPersisted: () => {},
      isModelInventoryAuthoritative: mockIsModelInventoryAuthoritative,
      refreshAllModelProviders: (...args: unknown[]) =>
        mockRefreshAllModelProviders(...args),
    }),
  },
}));

vi.mock("@/features/settings/stores/distroStore", () => ({
  useDistroStore: {
    getState: () => ({ refresh: async () => {}, setManifest: () => {} }),
  },
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: mockGetClient,
  setNotificationHandler: () => {},
  setPermissionHandler: () => {},
}));

vi.mock("@/features/security/acp/securityPermissionHandler", () => ({
  handleSecurityPermissionRequest: async () => {},
}));

vi.mock("@/features/chat/acp/acpNotificationHandler", () => ({
  default: {},
}));

vi.mock("@/features/chat/acp/sessionConfigSnapshotAdapter", () => ({
  registerChatSessionConfigSnapshotHandlers: () => {},
}));

vi.mock("@/shared/lib/perfLog", () => ({
  perfLog: () => {},
}));

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => ({ securityMl: false, byoKeyProviders: false }),
}));

vi.mock("@/shared/runtime-config/runtimeConfigStore", () => ({
  useRuntimeConfigStore: {
    getState: () => ({
      refresh: async () => ({ status: "ready" }),
      config: {},
      result: { status: "ready" },
    }),
  },
}));

vi.mock("@/shared/api/distro", () => ({
  getDistroBundle: async () => ({ present: false }),
}));

vi.mock("@/shared/api/agents", () => ({
  listPersonas: async () => [],
  migratePersonaTargetIfUnchanged: async () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runChatRuntimeStartup", () => {
  beforeEach(() => {
    // The latch is module state; a fresh import gives each test a fresh latch.
    vi.resetModules();
    mockLoadPersistedMessageQueues.mockReset();
    mockLoadPersistedMessageQueues.mockResolvedValue({});
    mockGetClient.mockReset();
    mockGetClient.mockResolvedValue({});
    mockRefreshAllModelProviders.mockReset();
    mockRefreshAllModelProviders.mockResolvedValue(undefined);
    mockGetModelCacheRefreshProviderIds.mockReset();
    mockGetModelCacheRefreshProviderIds.mockReturnValue([]);
    mockIsModelInventoryAuthoritative.mockReset();
    mockIsModelInventoryAuthoritative.mockReturnValue(false);
    mockPersonaTargetMigration.mockReset();
    mockPersonaTargetMigration.mockReturnValue(null);
    mockAgentState.personas = [];
    mockAgentState.providers = [];
    mockProviderModelState.providers = new Map();
    mockProviderModelState.runtimeManagedProviderIds = new Set();
  });

  it("collapses concurrent callers onto one startup run", async () => {
    const { runChatRuntimeStartup } = await import("./chatRuntimeStartup");
    const connect = deferred<unknown>();
    mockGetClient.mockReturnValue(connect.promise);

    const first = runChatRuntimeStartup();
    const second = runChatRuntimeStartup();

    // Both callers hold the same latch promise, and the run body started once.
    expect(second).toBe(first);
    expect(mockLoadPersistedMessageQueues).toHaveBeenCalledTimes(1);

    connect.resolve({});
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(mockGetClient).toHaveBeenCalledTimes(1);
  });

  it("does not block startup on model inventory refresh", async () => {
    const { runChatRuntimeStartup } = await import("./chatRuntimeStartup");
    const inventoryRefresh = deferred<void>();
    mockRefreshAllModelProviders.mockReturnValue(inventoryRefresh.promise);

    await expect(runChatRuntimeStartup()).resolves.toBeUndefined();
    expect(mockRefreshAllModelProviders).toHaveBeenCalledTimes(1);

    inventoryRefresh.resolve();
  });

  it.each([
    {
      label: "authoritative",
      authoritative: true,
      error: undefined,
      includesModel: true,
    },
    {
      label: "provisional",
      authoritative: false,
      error: undefined,
      includesModel: false,
    },
    {
      label: "errored",
      authoritative: true,
      error: "refresh failed",
      includesModel: false,
    },
  ])("uses only $label refreshed inventory for migration", async ({
    authoritative,
    error,
    includesModel,
  }) => {
    const model = { id: "openrouter-model", providerId: "openrouter" };
    mockAgentState.personas = [{ id: "persona-1", writable: true }];
    mockProviderModelState.providers = new Map([
      ["openrouter", { models: [model], ...(error ? { error } : {}) }],
    ]);
    mockGetModelCacheRefreshProviderIds.mockReturnValue(["openrouter"]);
    mockIsModelInventoryAuthoritative.mockReturnValue(authoritative);
    const { runChatRuntimeStartup } = await import("./chatRuntimeStartup");

    await runChatRuntimeStartup();

    await vi.waitFor(() =>
      expect(mockPersonaTargetMigration).toHaveBeenCalledWith(
        expect.objectContaining({ id: "persona-1" }),
        expect.objectContaining({
          models: includesModel ? [model] : [],
        }),
      ),
    );
  });

  it("stays latched after a successful run", async () => {
    const { runChatRuntimeStartup } = await import("./chatRuntimeStartup");
    const first = runChatRuntimeStartup();
    await first;

    expect(runChatRuntimeStartup()).toBe(first);
    await runChatRuntimeStartup();
    expect(mockLoadPersistedMessageQueues).toHaveBeenCalledTimes(1);
  });

  it("clears the latch on failure so a retry starts a genuine new attempt", async () => {
    const { runChatRuntimeStartup } = await import("./chatRuntimeStartup");
    mockGetClient.mockRejectedValueOnce(new Error("goosed unreachable"));

    const first = runChatRuntimeStartup();
    await expect(first).rejects.toThrow("goosed unreachable");

    // useAppStartup's retry() path: a new call after the failure settled must
    // start a second run rather than re-receive the rejected latch.
    const retry = runChatRuntimeStartup();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBeUndefined();
    expect(mockLoadPersistedMessageQueues).toHaveBeenCalledTimes(2);
  });

  it("hands a caller retrying inside its rejection handler a fresh attempt", async () => {
    const { runChatRuntimeStartup } = await import("./chatRuntimeStartup");
    mockGetClient.mockRejectedValueOnce(new Error("goosed unreachable"));

    const first = runChatRuntimeStartup();
    let retry: Promise<void> | undefined;
    await first.catch(() => {
      // The module's own rejection handler was attached before any caller's,
      // so the latch is already clear when a caller's handler retries.
      retry = runChatRuntimeStartup();
    });
    if (!retry) {
      throw new Error("first attempt did not reject");
    }

    expect(retry).not.toBe(first);
    // The failed attempt has fully settled by now; its rejection must not have
    // nulled out the latch the retry installed (the identity guard), so a
    // later caller still joins the retry run.
    expect(runChatRuntimeStartup()).toBe(retry);
    await expect(retry).resolves.toBeUndefined();
    expect(mockLoadPersistedMessageQueues).toHaveBeenCalledTimes(2);
  });

  it("runs startup again after a reset", async () => {
    const { runChatRuntimeStartup, resetChatRuntimeStartup } = await import(
      "./chatRuntimeStartup"
    );
    const first = runChatRuntimeStartup();
    await first;

    // The logout path: the next AppShell mount must get a genuine second run
    // rather than the previous account's settled promise.
    resetChatRuntimeStartup();

    const afterLogin = runChatRuntimeStartup();
    expect(afterLogin).not.toBe(first);
    await expect(afterLogin).resolves.toBeUndefined();
    expect(mockLoadPersistedMessageQueues).toHaveBeenCalledTimes(2);
    // The fresh run latches again for the rest of that login.
    expect(runChatRuntimeStartup()).toBe(afterLogin);
  });

  it("leaves a run started after a reset latched when the reset run settles", async () => {
    const { runChatRuntimeStartup, resetChatRuntimeStartup } = await import(
      "./chatRuntimeStartup"
    );
    const connect = deferred<unknown>();
    mockGetClient.mockReturnValueOnce(connect.promise);

    // Reset while the first run is still in flight: it is not cancelled, so
    // its later settling must not disturb the latch the second run installed.
    const first = runChatRuntimeStartup();
    resetChatRuntimeStartup();
    const second = runChatRuntimeStartup();
    expect(second).not.toBe(first);

    connect.reject(new Error("goosed unreachable"));
    await expect(first).rejects.toThrow("goosed unreachable");
    await expect(second).resolves.toBeUndefined();
    expect(runChatRuntimeStartup()).toBe(second);
  });
});
