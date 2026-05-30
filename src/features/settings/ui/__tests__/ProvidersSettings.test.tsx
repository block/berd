import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { ProvidersSettings } from "../ProvidersSettings";

const mocks = vi.hoisted(() => ({
  useCredentials: vi.fn(),
  checkAgentInstalled: vi.fn(),
}));

vi.mock("@/features/providers/hooks/useCredentials", () => ({
  useCredentials: () => mocks.useCredentials(),
}));

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) =>
    mocks.checkAgentInstalled(...args),
  checkAgentAuth: vi.fn(),
  installAgent: vi.fn(),
  authenticateAgent: vi.fn(),
  onAgentSetupOutput: vi.fn(async () => vi.fn()),
}));

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
    render(<ProvidersSettings />);

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

    render(<ProvidersSettings />);

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

    render(<ProvidersSettings />);

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
    render(<ProvidersSettings />);

    expect(
      screen.queryByRole("button", { name: /add custom provider/i }),
    ).not.toBeInTheDocument();
  });

  it("hides non-allowlisted model and custom providers for a distro", () => {
    useDistroStore.setState({
      loaded: true,
      manifest: { present: true, providerAllowlist: "databricks" },
    });
    render(<ProvidersSettings />);

    expect(screen.getByText("Databricks")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Acme Models")).not.toBeInTheDocument();
  });
});
