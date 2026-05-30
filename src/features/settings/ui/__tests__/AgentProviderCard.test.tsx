import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { AgentProviderCard } from "../AgentProviderCard";
import type { ProviderDisplayInfo } from "@/shared/types/providers";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import { AGENT_SETUP_FAILURE_SIMULATION_KEY } from "@/features/providers/lib/agentSetupFailureSimulation";

const checkAgentInstalled = vi.fn();
const checkAgentAuth = vi.fn();
const installAgent = vi.fn();
const authenticateAgent = vi.fn();
const onAgentSetupOutput = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) => checkAgentInstalled(...args),
  checkAgentAuth: (...args: unknown[]) => checkAgentAuth(...args),
  installAgent: (...args: unknown[]) => installAgent(...args),
  authenticateAgent: (...args: unknown[]) => authenticateAgent(...args),
  onAgentSetupOutput: (...args: unknown[]) => onAgentSetupOutput(...args),
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
    localStorage.removeItem(AGENT_SETUP_FAILURE_SIMULATION_KEY);
    checkAgentInstalled.mockResolvedValue(false);
    onAgentSetupOutput.mockResolvedValue(vi.fn());
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

  it("detects an installed local agent even when catalog status starts as not installed", async () => {
    checkAgentInstalled.mockResolvedValue(true);
    checkAgentAuth.mockResolvedValue(false);

    renderWithProviders(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
      />,
    );

    await waitFor(() => {
      expect(checkAgentInstalled).toHaveBeenCalledWith("claude-acp");
    });
    expect(
      await screen.findByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install claude/i }),
    ).not.toBeInTheDocument();
  });

  it("verifies install through the local CLI check and reports failure when the binary is still missing", async () => {
    const user = userEvent.setup();
    const onStartTroubleshootingChat = vi.fn();
    installAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(false);

    renderWithProviders(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        onStartTroubleshootingChat={onStartTroubleshootingChat}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: /install claude/i }),
    );

    await waitFor(() => {
      expect(checkAgentInstalled).toHaveBeenCalledWith("claude-acp");
    });
    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /troubleshoot in chat/i }),
    );
    expect(onStartTroubleshootingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Install finished, but the CLI isn't on your PATH",
        ),
      }),
    );
  });

  it("has localized install verification failure copy", () => {
    expect(
      enSettings.providers.agents.errors.installVerificationFailed,
    ).toContain("Install finished");
  });

  it("explains npm setup failures and starts a troubleshooting chat with raw output", async () => {
    const user = userEvent.setup();
    const onStartTroubleshootingChat = vi.fn();
    let outputHandler: ((line: string) => void) | undefined;

    onAgentSetupOutput.mockImplementation(
      async (_providerId: string, callback: (line: string) => void) => {
        outputHandler = callback;
        return vi.fn();
      },
    );
    installAgent.mockImplementation(async () => {
      outputHandler?.("npm error code EEXIST");
      outputHandler?.("npm error path /opt/homebrew/bin/claude");
      outputHandler?.("npm error EEXIST: file already exists");
      throw new Error("Command exited with code 1");
    });

    renderWithProviders(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        onStartTroubleshootingChat={onStartTroubleshootingChat}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: /install claude/i }),
    );

    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /troubleshoot in chat/i }),
    );

    expect(onStartTroubleshootingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Troubleshoot Claude setup",
        prompt: expect.stringContaining("/opt/homebrew/bin/claude"),
      }),
    );
  });

  it("can force a connected provider into a dev setup failure simulation", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      AGENT_SETUP_FAILURE_SIMULATION_KEY,
      JSON.stringify({
        providerId: "claude-acp",
        path: "/tmp/claude-agent-acp",
      }),
    );

    renderWithProviders(
      <AgentProviderCard
        provider={createProvider({
          status: "connected",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
          binaryName: "claude-agent-acp",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install claude/i }));

    expect(installAgent).not.toHaveBeenCalled();
    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/claude-agent-acp/i)).toBeInTheDocument();
  });
});
