import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { AgentProviderCard } from "../AgentProviderCard";
import type { ProviderDisplayInfo } from "@/shared/types/providers";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import enSettings from "@/shared/i18n/locales/en/settings.json";

const checkAgentInstalled = vi.fn();
const checkAgentAuth = vi.fn();
const installAgent = vi.fn();
const authenticateAgent = vi.fn();
const getProviderInventory = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) => checkAgentInstalled(...args),
  checkAgentAuth: (...args: unknown[]) => checkAgentAuth(...args),
  installAgent: (...args: unknown[]) => installAgent(...args),
  authenticateAgent: (...args: unknown[]) => authenticateAgent(...args),
  onAgentSetupOutput: vi.fn(async () => vi.fn()),
}));

vi.mock("@/features/providers/api/inventory", () => ({
  getProviderInventory: (...args: unknown[]) => getProviderInventory(...args),
}));

function createProvider(
  overrides: Partial<ProviderDisplayInfo> = {},
): ProviderDisplayInfo {
  return {
    id: "claude-acp",
    displayName: "Claude",
    category: "agent",
    description: "Claude provider",
    setupMethod: "cli_auth",
    binaryName: "claude",
    supportsAuth: true,
    supportsAuthStatus: true,
    group: "default",
    status: "connected",
    ...overrides,
  };
}

describe("AgentProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProviderInventoryStore.getState().setEntries([]);
  });

  it("shows the checking indicator and does not show sign in while auth status is checking", async () => {
    let resolveAuth!: (authenticated: boolean) => void;
    const authPromise = new Promise<boolean>((resolve) => {
      resolveAuth = resolve;
    });

    checkAgentInstalled.mockResolvedValue(true);
    checkAgentAuth.mockReturnValue(authPromise);

    renderWithProviders(<AgentProviderCard provider={createProvider()} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole("status", { name: "Checking..." }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking...")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in/i }),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveAuth(false);
      await authPromise;
    });

    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
  });

  it("verifies install through provider inventory and reports failure when core still marks it unconfigured", async () => {
    const user = userEvent.setup();
    installAgent.mockResolvedValue(undefined);
    getProviderInventory.mockResolvedValue([
      {
        providerId: "claude-acp",
        providerName: "Claude",
        description: "",
        defaultModel: "",
        configured: false,
        providerType: "Claude",
        category: "agent",
        configKeys: [],
        setupSteps: [],
        supportsRefresh: true,
        refreshing: false,
        models: [],
        stale: false,
      },
    ]);

    renderWithProviders(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install claude/i }));

    await waitFor(() => {
      expect(getProviderInventory).toHaveBeenCalledWith(["claude-acp"]);
    });
    expect(checkAgentInstalled).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        /install finished, but the cli isn't on your path/i,
      ),
    ).toBeInTheDocument();
    expect(
      useProviderInventoryStore.getState().entries.get("claude-acp")
        ?.configured,
    ).toBe(false);
  });

  it("has localized install verification failure copy", () => {
    expect(
      enSettings.providers.agents.errors.installVerificationFailed,
    ).toContain("Install finished");
  });
});
