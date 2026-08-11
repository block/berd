import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import { ProvidersSettings } from "../ProvidersSettings";

const mocks = vi.hoisted(() => ({
  useCredentials: vi.fn(),
  startAgentSetup: vi.fn(),
  clearAgentSetupStatus: vi.fn(),
  listAgentSetupStatus: vi.fn(),
  onAgentSetupState: vi.fn(),
  useAgentProviderStatus: vi.fn(),
  listProviderSetupCatalog: vi.fn(),
  listCustomProviders: vi.fn(),
  listProviderSecrets: vi.fn(),
}));

vi.mock("@/features/providers/api/catalog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/providers/api/catalog")>();
  return {
    ...actual,
    listProviderSetupCatalog: mocks.listProviderSetupCatalog,
  };
});

vi.mock("@/features/providers/api/customProviders", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/providers/api/customProviders")
    >();
  return {
    ...actual,
    listCustomProviders: mocks.listCustomProviders,
  };
});

vi.mock("@/features/providers/api/credentials", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/providers/api/credentials")
    >();
  return {
    ...actual,
    listProviderSecrets: mocks.listProviderSecrets,
  };
});

vi.mock("@/features/providers/hooks/useCredentials", () => ({
  useCredentials: () => mocks.useCredentials(),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => mocks.useAgentProviderStatus(),
}));

vi.mock("@/features/providers/api/agentSetup", () => ({
  startAgentSetup: (...args: unknown[]) => mocks.startAgentSetup(...args),
  clearAgentSetupStatus: (...args: unknown[]) =>
    mocks.clearAgentSetupStatus(...args),
  listAgentSetupStatus: (...args: unknown[]) =>
    mocks.listAgentSetupStatus(...args),
  getAgentSetupStatus: vi.fn(),
  onAgentSetupState: (...args: unknown[]) => mocks.onAgentSetupState(...args),
}));

function renderProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const providerCatalog: ProviderCatalogEntry[] = [
  {
    id: "goose",
    displayName: "Goose",
    category: "agent",
    description: "Block's open-source coding agent",
    setupMethod: "none",
    group: "default",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    category: "model",
    description: "GPT and o-series models",
    setupMethod: "config_fields",
    group: "default",
  },
  {
    id: "databricks_v2",
    displayName: "Databricks",
    category: "model",
    description: "Databricks Foundation Models",
    setupMethod: "host_with_oauth_fallback",
    nativeConnectQuery: "databricks",
    group: "default",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    category: "model",
    description: "Claude models",
    setupMethod: "single_api_key",
    group: "default",
  },
  {
    id: "claude-acp",
    displayName: "Claude",
    category: "agent",
    description: "Claude Code",
    setupMethod: "cli_auth",
    binaryName: "claude-agent-acp",
    supportsInstall: true,
    supportsAuth: false,
    supportsAuthStatus: false,
    group: "default",
  },
  {
    id: "amp-acp",
    displayName: "Amp",
    category: "agent",
    description: "Amp",
    setupMethod: "cli_auth",
    binaryName: "amp-acp",
    supportsInstall: true,
    supportsAuth: false,
    supportsAuthStatus: false,
    group: "default",
  },
  {
    id: "codex-acp",
    displayName: "Codex",
    category: "agent",
    description: "Codex",
    setupMethod: "cli_auth",
    binaryName: "codex-acp",
    supportsInstall: true,
    supportsAuth: false,
    supportsAuthStatus: false,
    group: "default",
  },
];

// A runtime config that allows every model provider in the test catalog, so
// the default test state shows all model providers. Individual tests override
// the store to exercise allowlist filtering and unavailable fallback.
const allModelProvidersConfig: RuntimeConfig = {
  ...DEFAULT_RUNTIME_CONFIG,
  goose: {
    ...DEFAULT_RUNTIME_CONFIG.goose,
    modelProviders: [
      {
        id: "databricks_v2",
        displayName: "Databricks",
        models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
      },
      {
        id: "openai",
        displayName: "OpenAI",
        models: [{ id: "gpt-5", name: "GPT-5" }],
      },
      {
        id: "anthropic",
        displayName: "Anthropic",
        models: [{ id: "claude-opus", name: "Claude" }],
      },
    ],
  },
};

const MANAGED_RUNTIME_CONFIG: RuntimeConfig = {
  ...DEFAULT_RUNTIME_CONFIG,
  goose: {
    defaultModelProviderId: "databricks_v2",
    defaultModelId: "goose-gpt-5-5",
    modelProviders: [
      {
        id: "databricks_v2",
        displayName: "Databricks AI Gateway",
        models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
      },
    ],
  },
};

describe("ProvidersSettings", () => {
  beforeEach(() => {
    mocks.listProviderSecrets.mockResolvedValue([]);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    useProviderCatalogStore.getState().setEntries(providerCatalog);
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "fakeEndpoint",
        config: allModelProvidersConfig,
      },
      config: allModelProvidersConfig,
    });
    useAgentSetupStore.setState({ operations: new Map() });
    useDistroStore.setState({
      loaded: false,
      manifest: { present: false, kgooseConfigured: false },
    });
    mocks.listProviderSetupCatalog.mockResolvedValue([]);
    mocks.listCustomProviders.mockResolvedValue([]);
    mocks.clearAgentSetupStatus.mockResolvedValue(undefined);
    mocks.listAgentSetupStatus.mockResolvedValue([]);
    mocks.onAgentSetupState.mockResolvedValue(vi.fn());
    // The backend reports the operation finished; the card then runs its
    // post-success refresh and marks the provider ready.
    mocks.startAgentSetup.mockResolvedValue({
      action: "install",
      phase: "idle",
      status: "succeeded",
      output: [],
      error: null,
    });
    mocks.useAgentProviderStatus.mockReturnValue({
      readyAgentIds: new Set<string>(["goose"]),
      agentReadiness: new Map<string, AgentProviderReadiness>([
        ["goose", "ready"],
      ]),
      agentChecks: new Map(),
      loading: false,
      refresh: vi.fn(),
    });
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    });
  });

  it("does not refetch or overwrite the reconciled provider catalog", async () => {
    const databricks = providerCatalog.find(
      (provider) => provider.id === "databricks_v2",
    );
    if (!databricks) throw new Error("Databricks fixture is missing");
    const runtimeDatabricks: ProviderCatalogEntry = {
      ...databricks,
      catalogSource: "runtime",
      fields: [
        {
          key: "DATABRICKS_HOST",
          label: "Host URL",
          secret: false,
          required: true,
        },
      ],
    };
    useProviderCatalogStore.getState().mergeEntries([runtimeDatabricks]);
    mocks.listProviderSetupCatalog.mockResolvedValue([
      {
        ...runtimeDatabricks,
        catalogSource: "setup",
        fields: [
          ...(runtimeDatabricks.fields ?? []),
          {
            key: "DATABRICKS_TOKEN",
            label: "Access Token",
            secret: true,
            required: false,
          },
        ],
      },
    ]);

    renderProviders(<ProvidersSettings />);

    await waitFor(() => {
      expect(mocks.listCustomProviders).toHaveBeenCalledTimes(1);
    });
    expect(mocks.listProviderSetupCatalog).not.toHaveBeenCalled();
    expect(
      useProviderCatalogStore
        .getState()
        .entries.find((provider) => provider.id === "databricks_v2"),
    ).toEqual(runtimeDatabricks);
  });

  it("does not show the restart banner for provider credential changes", async () => {
    renderProviders(<ProvidersSettings />);

    await waitFor(() => {
      expect(mocks.listCustomProviders).toHaveBeenCalledTimes(1);
    });

    expect(
      screen.queryByText(/restart to apply credential changes/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /restart now/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back to provider rows when credential status loading stalls", async () => {
    vi.useFakeTimers();
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(),
      loading: true,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    });

    try {
      renderProviders(<ProvidersSettings />);

      expect(
        screen.getAllByText("Checking provider status...").length,
      ).toBeGreaterThan(0);
      expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Connect a model provider"),
      ).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(
        screen.getAllByText("Connect a model provider").length,
      ).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: /model providers/i }));
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /add provider/i }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to provider rows when stored provider secrets stall", async () => {
    vi.useFakeTimers();
    let resolveStalledSecrets: (
      value: Awaited<ReturnType<typeof mocks.listProviderSecrets>>,
    ) => void = () => {};
    mocks.listProviderSecrets.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStalledSecrets = resolve;
      }),
    );
    const credentials = {
      configuredIds: new Set<string>(),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    };
    mocks.useCredentials.mockReturnValue(credentials);

    try {
      const rendered = renderProviders(<ProvidersSettings />);

      expect(
        screen.getAllByText("Checking provider status...").length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByText("Connect a model provider"),
      ).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(
        screen.getAllByText("Connect a model provider").length,
      ).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: /model providers/i }));
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /add provider/i }),
      ).toBeInTheDocument();

      mocks.listProviderSecrets.mockResolvedValueOnce([]);
      mocks.useCredentials.mockReturnValue({
        ...credentials,
        credentialRevision: 1,
      });
      rendered.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <ProvidersSettings />
        </QueryClientProvider>,
      );
      await act(async () => {
        resolveStalledSecrets([
          {
            id: "provider_cache:openai",
            provider: "openai",
            providerDisplayName: "OpenAI",
            name: "API key",
            storage: "provider_cache",
            status: "valid",
            configured: true,
            hasSecret: true,
            canDelete: true,
            canConfigure: true,
          },
        ]);
        await Promise.resolve();
      });

      expect(mocks.listProviderSecrets).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Active")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash connect prompt while stored provider secrets load", async () => {
    let resolveSecrets: (
      value: Awaited<ReturnType<typeof mocks.listProviderSecrets>>,
    ) => void = () => {};
    mocks.listProviderSecrets.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecrets = resolve;
      }),
    );
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    });

    renderProviders(<ProvidersSettings />);

    expect(
      screen.getAllByText("Checking provider status...").length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("Connect a model provider"),
    ).not.toBeInTheDocument();

    resolveSecrets([
      {
        id: "provider_cache:openai",
        provider: "openai",
        providerDisplayName: "OpenAI",
        name: "API key",
        storage: "provider_cache",
        status: "valid",
        configured: true,
        hasSecret: true,
        canDelete: true,
        canConfigure: true,
      },
    ]);

    await waitFor(() => {
      expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByText("Connect a model provider"),
    ).not.toBeInTheDocument();
  });

  it("shows an unconfigured runtime-managed provider with a Connect action", async () => {
    const user = userEvent.setup();

    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "fakeEndpoint",
        config: MANAGED_RUNTIME_CONFIG,
      },
      config: MANAGED_RUNTIME_CONFIG,
    });

    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /model providers/i }));
    await user.click(screen.getByRole("button", { name: "Databricks" }));

    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("does not summarize default-ready providers as connected", async () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "aws_bedrock",
        displayName: "AWS Bedrock",
        category: "model",
        description: "Models on AWS",
        setupMethod: "cloud_credentials",
        group: "additional",
        catalogSource: "setup",
        fields: [
          {
            key: "AWS_REGION",
            label: "AWS Region",
            secret: false,
            required: true,
            defaultValue: "us-east-1",
          },
        ],
      },
      {
        id: "lmstudio",
        displayName: "LM Studio",
        category: "model",
        description: "Run local models",
        setupMethod: "config_fields",
        group: "additional",
        catalogSource: "setup",
        fields: [
          {
            key: "LMSTUDIO_HOST",
            label: "Host URL",
            secret: false,
            required: false,
            defaultValue: "http://localhost:1234",
          },
        ],
      },
      {
        id: "atomic_chat",
        displayName: "Atomic Chat",
        category: "model",
        description: "Run local models",
        setupMethod: "config_fields",
        group: "additional",
        catalogSource: "setup",
        fields: [
          {
            key: "ATOMIC_CHAT_HOST",
            label: "Host URL",
            secret: false,
            required: false,
            defaultValue: "http://localhost:1337",
          },
        ],
      },
    ]);
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>([
        "databricks_v2",
        "aws_bedrock",
        "lmstudio",
        "atomic_chat",
      ]),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    });

    renderProviders(<ProvidersSettings />);

    await waitFor(() => {
      expect(
        screen.getAllByText("Connect a model provider").length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen
        .queryAllByText("Databricks")
        .every((node) => node.closest('[aria-hidden="true"]') !== null),
    ).toBe(true);
    expect(
      screen.queryByText(/AWS Bedrock, LM Studio, Atomic Chat/),
    ).not.toBeInTheDocument();
  });

  it("tags a provider Configured when a non-secret endpoint is saved without a credential", async () => {
    const user = userEvent.setup();
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "lmstudio",
        displayName: "LM Studio",
        category: "model",
        description: "Run local models",
        setupMethod: "config_fields",
        group: "additional",
        catalogSource: "setup",
        fields: [
          {
            key: "LMSTUDIO_API_KEY",
            label: "API key",
            secret: true,
            required: false,
          },
          {
            key: "LMSTUDIO_HOST",
            label: "Host URL",
            secret: false,
            required: false,
            defaultValue: "http://localhost:1234",
          },
        ],
      },
      {
        id: "ollama",
        displayName: "Ollama",
        category: "model",
        description: "Run local models",
        setupMethod: "config_fields",
        group: "additional",
        catalogSource: "setup",
        fields: [
          {
            key: "OLLAMA_HOST",
            label: "Host URL",
            secret: false,
            required: false,
            defaultValue: "http://localhost:11434",
          },
        ],
      },
    ]);
    const getConfig = vi.fn(async (providerId: string) => {
      if (providerId === "lmstudio") {
        return [
          {
            key: "LMSTUDIO_HOST",
            value: "http://my-box:9999",
            isSet: true,
            isSecret: false,
            required: false,
          },
        ];
      }
      // Leave Ollama pending to prove one slow provider cannot block another
      // provider's Configured result.
      return await new Promise<never>(() => {});
    });
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(["lmstudio", "ollama"]),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig,
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    });

    renderProviders(<ProvidersSettings />);
    await user.click(screen.getByRole("button", { name: /model providers/i }));

    // The user-touched provider earns the Configured tag but stays out of
    // the Active summary; the default-only provider stays out of the main page.
    expect(await screen.findByText("Configured")).toBeInTheDocument();
    const lmStudioRow = screen
      .getByText("LM Studio")
      .closest("button") as HTMLElement;
    expect(within(lmStudioRow).getByText("Configured")).toBeInTheDocument();
    expect(within(lmStudioRow).queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByText("Ollama")).not.toBeInTheDocument();
  });

  it("clears stale Active evidence when credential refresh fails", async () => {
    const user = userEvent.setup();
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "github_copilot",
        displayName: "GitHub Copilot",
        category: "model",
        description: "GitHub models",
        setupMethod: "oauth_device_code",
        group: "additional",
        catalogSource: "setup",
      },
    ]);
    mocks.listProviderSecrets.mockResolvedValueOnce([
      {
        id: "provider_cache:github_copilot",
        provider: "github_copilot",
        providerDisplayName: "GitHub Copilot",
        name: "OAuth token",
        storage: "provider_cache",
        status: "valid",
        configured: true,
        hasSecret: true,
        canDelete: true,
        canConfigure: false,
      },
    ]);
    const credentials = {
      configuredIds: new Set<string>(),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    };
    mocks.useCredentials.mockReturnValue(credentials);

    const rendered = renderProviders(<ProvidersSettings />);
    await user.click(screen.getByRole("button", { name: /model providers/i }));
    expect(
      (await screen.findAllByText("GitHub Copilot")).length,
    ).toBeGreaterThan(0);

    let rejectCredentialRefresh: (error: Error) => void = () => {};
    mocks.listProviderSecrets.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectCredentialRefresh = reject;
      }),
    );
    mocks.useCredentials.mockReturnValue({
      ...credentials,
      credentialRevision: 1,
    });
    rendered.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProvidersSettings />
      </QueryClientProvider>,
    );

    expect(screen.getAllByText("GitHub Copilot").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("Checking provider status..."),
    ).not.toBeInTheDocument();

    await act(async () => {
      rejectCredentialRefresh(new Error("offline"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("GitHub Copilot")).not.toBeInTheDocument();
    });
  });

  it("shows active providers first while preserving order within each group", async () => {
    const user = userEvent.setup();
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(["openai", "databricks_v2"]),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
      credentialRevision: 0,
    });

    mocks.listProviderSecrets.mockResolvedValue([
      {
        id: "provider_cache:openai",
        provider: "openai",
        providerDisplayName: "OpenAI",
        name: "API key",
        storage: "provider_cache",
        status: "valid",
        configured: true,
        hasSecret: true,
        canDelete: true,
        canConfigure: true,
      },
      {
        id: "provider_cache:databricks_v2",
        provider: "databricks_v2",
        providerDisplayName: "Databricks",
        name: "OAuth token",
        storage: "provider_cache",
        status: "valid",
        configured: true,
        hasSecret: true,
        canDelete: true,
        canConfigure: false,
      },
    ]);
    renderProviders(<ProvidersSettings />);
    expect(await screen.findByText("OpenAI, Databricks")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /model providers/i }));

    const openai = screen.getByText("OpenAI");
    const databricks = screen.getByText("Databricks");
    const anthropic = screen.getByText("Anthropic");

    expect(
      openai.compareDocumentPosition(databricks) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      databricks.compareDocumentPosition(anthropic) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("mounts only one provider row while its setup is open in the modal", async () => {
    const user = userEvent.setup();
    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /model providers/i }));
    expect(screen.getAllByRole("button", { name: "OpenAI" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /add provider/i }));
    await user.click(screen.getByRole("button", { name: /openai/i }));

    expect(screen.getAllByRole("button", { name: "OpenAI" })).toHaveLength(1);
  });

  it("loads existing custom providers through the provider API", async () => {
    const user = userEvent.setup();
    mocks.listCustomProviders.mockResolvedValue([
      {
        providerId: "my-provider",
        displayName: "My Provider",
        configured: true,
        modelCount: 1,
      },
    ]);

    renderProviders(<ProvidersSettings />);
    await user.click(screen.getByRole("button", { name: /model providers/i }));

    expect(await screen.findByText("My Provider")).toBeInTheDocument();
    expect(mocks.listCustomProviders).toHaveBeenCalledTimes(1);
  });

  it("shows the custom provider creation entry point (BYO default-on)", async () => {
    const user = userEvent.setup();

    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /model providers/i }));

    expect(
      screen.getByRole("button", { name: /add provider/i }),
    ).toBeInTheDocument();
  });

  it("shows the agent draft return action after setup succeeds during a detour", async () => {
    const user = userEvent.setup();
    const onReturnToAgentDraft = vi.fn();
    // Claude starts absent from the shared report (useAgentProviderStatus mock
    // omits it), so the card renders "Install Claude". `startAgentSetup`
    // resolves to a succeeded operation, so the card runs its post-success
    // refresh and marks the provider ready, surfacing the return action.

    renderProviders(
      <ProvidersSettings onReturnToAgentDraft={onReturnToAgentDraft} />,
    );

    expect(
      screen.queryByRole("button", { name: "Return to agent draft" }),
    ).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: "Install Claude" }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Return to agent draft" }),
      ).toBeInTheDocument();
    });
  });

  it("hides non-allowlisted model and custom providers for runtime config", async () => {
    const user = userEvent.setup();
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "fakeEndpoint",
        config: MANAGED_RUNTIME_CONFIG,
      },
      config: MANAGED_RUNTIME_CONFIG,
    });
    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /model providers/i }));

    expect(screen.getByText("Databricks")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Acme Models")).not.toBeInTheDocument();
  });

  it("falls back to the default allowlist when runtime config is unavailable", async () => {
    const user = userEvent.setup();

    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "unavailable",
        source: "endpoint",
        reason: "endpointUnavailable",
        message: "runtime config unavailable",
      },
      config: MANAGED_RUNTIME_CONFIG,
    });

    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /model providers/i }));

    expect(screen.getByText("Databricks")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
  });
});
