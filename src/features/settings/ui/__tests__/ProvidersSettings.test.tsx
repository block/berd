import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { ProvidersSettings } from "../ProvidersSettings";

const mocks = vi.hoisted(() => ({
  useCredentials: vi.fn(),
  checkAgentInstalled: vi.fn(),
  installAgent: vi.fn(),
  useAgentProviderStatus: vi.fn(),
}));

vi.mock("@/features/providers/hooks/useCredentials", () => ({
  useCredentials: () => mocks.useCredentials(),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => mocks.useAgentProviderStatus(),
}));

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) =>
    mocks.checkAgentInstalled(...args),
  installAgent: (...args: unknown[]) => mocks.installAgent(...args),
  authenticateAgent: vi.fn(),
  onAgentSetupOutput: vi.fn(async () => vi.fn()),
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
    id: "databricks",
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

describe("ProvidersSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    useProviderCatalogStore.getState().setEntries(providerCatalog);
    useDistroStore.setState({ loaded: false, manifest: { present: false } });
    mocks.checkAgentInstalled.mockResolvedValue(true);
    mocks.installAgent.mockResolvedValue(undefined);
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

  it("renders the loaded provider catalog while credential status is loading", () => {
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

    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Checking provider status...")).toBeInTheDocument();
  });

  it("matches main by ordering connected model providers first after status loads", () => {
    mocks.useCredentials.mockReturnValue({
      configuredIds: new Set<string>(["openai", "databricks"]),
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

  it("does not show the custom provider creation entry point", () => {
    renderProviders(<ProvidersSettings />);

    expect(
      screen.queryByRole("button", { name: /add custom provider/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the agent draft return action after setup succeeds during a detour", async () => {
    const user = userEvent.setup();
    const onReturnToAgentDraft = vi.fn();
    // Claude starts absent from the shared report (useAgentProviderStatus mock
    // omits it), so the card renders "Install Claude". The post-install
    // verification probe then confirms the CLI landed on PATH.
    mocks.checkAgentInstalled.mockResolvedValue(true);

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

  it("hides non-allowlisted model and custom providers for a distro", () => {
    useDistroStore.setState({
      loaded: true,
      manifest: { present: true, providerAllowlist: "databricks" },
    });
    renderProviders(<ProvidersSettings />);

    expect(screen.getByText("Databricks")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Acme Models")).not.toBeInTheDocument();
  });
});
