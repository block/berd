import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
}));

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
      ...DEFAULT_RUNTIME_CONFIG.goose.modelProviders,
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

describe("ProvidersSettings", () => {
  beforeEach(() => {
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
    useDistroStore.setState({ loaded: false, manifest: { present: false } });
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
      getConfig: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
    });
  });

  it("does not show the restart banner for provider credential changes", () => {
    renderProviders(<ProvidersSettings />);

    expect(
      screen.queryByText(/restart to apply credential changes/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /restart now/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the loaded provider catalog while credential status is loading", async () => {
    const user = userEvent.setup();
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(),
      loading: true,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
    });

    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /goose/i }));

    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Checking provider status...")).toBeInTheDocument();
  });

  it("matches main by ordering connected model providers first after status loads", async () => {
    const user = userEvent.setup();
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(["openai", "databricks_v2"]),
      loading: false,
      saving: false,
      savingProviderIds: new Set<string>(),
      syncingProviderIds: new Set<string>(),
      modelWarnings: new Map<string, string>(),
      getConfig: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      completeNativeSetup: vi.fn(),
    });

    renderProviders(<ProvidersSettings />);

    expect(screen.getByText("Model providers")).toBeInTheDocument();
    expect(screen.getByText("OpenAI, Databricks")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /goose/i }));

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

  it("shows the custom provider creation entry point (BYO default-on)", async () => {
    const user = userEvent.setup();

    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /goose/i }));

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
        config: DEFAULT_RUNTIME_CONFIG,
      },
      config: DEFAULT_RUNTIME_CONFIG,
    });
    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /goose/i }));

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
      config: DEFAULT_RUNTIME_CONFIG,
    });

    renderProviders(<ProvidersSettings />);

    await user.click(screen.getByRole("button", { name: /goose/i }));

    expect(screen.getByText("Databricks")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
  });
});
