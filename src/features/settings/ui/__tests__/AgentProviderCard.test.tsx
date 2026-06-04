import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import { AgentProviderCard } from "../AgentProviderCard";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { DoctorCheck } from "@/shared/api/doctor";
import type { ProviderDisplayInfo } from "@/shared/types/providers";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import { AGENT_SETUP_FAILURE_SIMULATION_KEY } from "@/features/providers/lib/agentSetupFailureSimulation";

const checkAgentInstalled = vi.fn();
const installAgent = vi.fn();
const authenticateAgent = vi.fn();
const updateAgent = vi.fn();
const onAgentSetupOutput = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) => checkAgentInstalled(...args),
  installAgent: (...args: unknown[]) => installAgent(...args),
  authenticateAgent: (...args: unknown[]) => authenticateAgent(...args),
  updateAgent: (...args: unknown[]) => updateAgent(...args),
  onAgentSetupOutput: (...args: unknown[]) => onAgentSetupOutput(...args),
}));

const rerunDoctorReport = vi.fn();
const invalidateDoctorReport = vi.fn();

vi.mock("@/shared/api/useDoctorReport", () => ({
  rerunDoctorReport: (...args: unknown[]) => rerunDoctorReport(...args),
  invalidateDoctorReport: (...args: unknown[]) =>
    invalidateDoctorReport(...args),
}));

function renderCard(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  return {
    ...result,
    rerender: (node: ReactElement) => result.rerender(wrap(node)),
  };
}

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

function createVersionCheck(overrides: Partial<DoctorCheck> = {}): DoctorCheck {
  return {
    id: "ai-agent-claude",
    label: "Claude",
    status: "pass",
    message: "Installed",
    fixUrl: null,
    fixCommand: null,
    fixType: null,
    path: null,
    bridgePath: null,
    rawOutput: null,
    authStatus: null,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: null,
    installSource: null,
    selfUpdating: null,
    main: null,
    bridge: null,
    category: "agents",
    categoryLabel: "Agents",
    ...overrides,
  };
}

describe("AgentProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(AGENT_SETUP_FAILURE_SIMULATION_KEY);
    checkAgentInstalled.mockResolvedValue(false);
    onAgentSetupOutput.mockResolvedValue(vi.fn());
    rerunDoctorReport.mockResolvedValue(undefined);
    invalidateDoctorReport.mockResolvedValue(undefined);
  });

  it("shows the checking indicator only during the shared report's first load", async () => {
    const { rerender } = renderCard(
      <AgentProviderCard provider={createProvider()} statusLoading={true} />,
    );

    expect(
      screen.getByRole("status", { name: "Checking..." }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking...")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in/i }),
    ).not.toBeInTheDocument();

    // The cold load resolved to "installed but not authenticated".
    rerender(
      <AgentProviderCard
        provider={createProvider()}
        statusLoading={false}
        readiness={"not_ready" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
    // No per-card probe runs on mount anymore.
    expect(checkAgentInstalled).not.toHaveBeenCalled();
  });

  it("does not re-spin on a warm-cache revisit", () => {
    renderCard(
      <AgentProviderCard
        provider={createProvider()}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.queryByRole("status", { name: "Checking..." }),
    ).not.toBeInTheDocument();
    expect(checkAgentInstalled).not.toHaveBeenCalled();
  });

  it("renders sign in for an installed-but-unauthenticated agent", () => {
    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_ready" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install claude/i }),
    ).not.toBeInTheDocument();
  });

  it("offers install when the report reports the binary missing", () => {
    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "connected",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
          binaryName: "claude-agent-acp",
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.getByRole("button", { name: /install claude/i }),
    ).toBeInTheDocument();
  });

  it("verifies install through the local CLI check and reports failure when the binary is still missing", async () => {
    const user = userEvent.setup();
    const onStartTroubleshootingChat = vi.fn();
    installAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(false);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
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

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
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

  it("surfaces install source and version from the shared report", () => {
    renderCard(
      <AgentProviderCard
        provider={createProvider({ supportsAuth: false })}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          installSource: "brew",
          installedVersion: "1.2.3",
        })}
      />,
    );

    expect(
      screen.getByText("Installed via Homebrew · v1.2.3"),
    ).toBeInTheDocument();
  });

  it("wires the bottom Update button to the per-readout update command", async () => {
    const user = userEvent.setup();
    updateAgent.mockResolvedValue(undefined);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          installSource: "npm",
          installedVersion: "1.2.3",
          latestVersion: "1.3.0",
          updateAvailable: true,
          main: {
            installSource: "npm",
            installedVersion: "1.2.3",
            latestVersion: "1.3.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
            updateFixType: "updateMain",
          },
        })}
      />,
    );

    expect(screen.getByText("Update available → v1.3.0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^update$/i }));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith(
        "claude-acp",
        "updateMain",
        "npm install -g @anthropic-ai/claude-code@latest",
      );
    });
    expect(installAgent).not.toHaveBeenCalled();

    // After a successful update we re-run the freshness pass (not a bare
    // invalidate) so the version badges repopulate instead of blanking out.
    await waitFor(() => {
      expect(rerunDoctorReport).toHaveBeenCalled();
    });
    expect(invalidateDoctorReport).not.toHaveBeenCalled();
  });

  it("runs every actionable readout sequentially when both main and bridge are out of date", async () => {
    const user = userEvent.setup();
    updateAgent.mockResolvedValue(undefined);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          main: {
            installSource: "curlPipe",
            installedVersion: "2.0.0",
            latestVersion: "2.1.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "curl -fsSL https://example.com/install.sh | bash",
            updateFixType: "updateMain",
          },
          bridge: {
            installSource: "npm",
            installedVersion: "0.34.0",
            latestVersion: "0.39.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "npm install -g claude-agent-acp@latest",
            updateFixType: "updateBridge",
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^update$/i }));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledTimes(2);
    });
    expect(updateAgent).toHaveBeenNthCalledWith(
      1,
      "claude-acp",
      "updateMain",
      "curl -fsSL https://example.com/install.sh | bash",
    );
    expect(updateAgent).toHaveBeenNthCalledWith(
      2,
      "claude-acp",
      "updateBridge",
      "npm install -g claude-agent-acp@latest",
    );
  });

  it("hides the update affordance for self-updating tools", () => {
    renderCard(
      <AgentProviderCard
        provider={createProvider({
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          installSource: "curlPipe",
          installedVersion: "1.2.3",
          latestVersion: "1.3.0",
          updateAvailable: true,
          selfUpdating: true,
        })}
      />,
    );

    expect(screen.queryByText(/auto-updates/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /update claude/i }),
    ).not.toBeInTheDocument();
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

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "connected",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
          binaryName: "claude-agent-acp",
        })}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install claude/i }));

    expect(installAgent).not.toHaveBeenCalled();
    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/claude-agent-acp/i)).toBeInTheDocument();
  });
});
