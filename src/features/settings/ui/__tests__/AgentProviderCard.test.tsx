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
const nextAgentInstallFix = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  checkAgentInstalled: (...args: unknown[]) => checkAgentInstalled(...args),
  installAgent: (...args: unknown[]) => installAgent(...args),
  authenticateAgent: (...args: unknown[]) => authenticateAgent(...args),
  updateAgent: (...args: unknown[]) => updateAgent(...args),
  onAgentSetupOutput: (...args: unknown[]) => onAgentSetupOutput(...args),
  nextAgentInstallFix: (...args: unknown[]) => nextAgentInstallFix(...args),
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
    // Default: nothing further to install after the seeded recipe, so every
    // existing single-install assertion stays a one-pass install.
    nextAgentInstallFix.mockResolvedValue(null);
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

  it("signs in an installed-but-unauthenticated agent", async () => {
    const user = userEvent.setup();
    authenticateAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(true);

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

    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(authenticateAgent).toHaveBeenCalledWith("claude-acp");
    });
    expect(installAgent).not.toHaveBeenCalled();
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

  it("offers install without sign in when the agent is not installed", async () => {
    const user = userEvent.setup();
    installAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(true);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.getByRole("button", { name: /install claude/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in to claude/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /install claude/i }));

    await waitFor(() => {
      expect(installAgent).toHaveBeenCalledWith("claude-acp", "command");
    });
    expect(authenticateAgent).not.toHaveBeenCalled();
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

    // A plain install (no bridge-missing check) dispatches the main-CLI recipe.
    await waitFor(() => {
      expect(installAgent).toHaveBeenCalledWith("claude-acp", "command");
    });
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

  it("wires the top-right Update button to the per-readout update command", async () => {
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

    await user.click(screen.getByRole("button", { name: /update claude/i }));

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

  it("renders update and sign in as separate actions for an unauthenticated stale agent", async () => {
    const user = userEvent.setup();
    updateAgent.mockResolvedValue(undefined);
    authenticateAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(true);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_ready" satisfies AgentProviderReadiness}
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

    expect(
      screen.getByRole("button", { name: /update claude/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in to claude/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /update claude/i }));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith(
        "claude-acp",
        "updateMain",
        "npm install -g @anthropic-ai/claude-code@latest",
      );
    });
    expect(authenticateAgent).not.toHaveBeenCalled();

    await user.click(
      await screen.findByRole("button", { name: /sign in to claude/i }),
    );

    await waitFor(() => {
      expect(authenticateAgent).toHaveBeenCalledWith("claude-acp");
    });
  });

  it("offers Fix without sign in when the ACP bridge is missing and the main CLI is out of date", () => {
    // Codex's main CLI is installed via Homebrew with an update available, but
    // the codex-acp bridge is absent. The shared report resolves this to
    // not_installed (fixType="bridge") *and* an update is pending, so the
    // setup action becomes "Fix" without the Sign in action; it is not a ready
    // tick, and not the plain "Update" affordance.
    const { container } = renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "codex-acp",
          displayName: "Codex",
          binaryName: "codex-acp",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          id: "ai-agent-codex",
          label: "Codex",
          status: "warn",
          path: "/opt/homebrew/bin/codex",
          bridgePath: null,
          fixType: "bridge",
          installSource: "brew",
          installedVersion: "0.137.0",
          latestVersion: "0.139.0",
          updateAvailable: true,
          main: {
            installSource: "brew",
            installedVersion: "0.137.0",
            latestVersion: "0.139.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "brew upgrade codex",
            updateFixType: "updateMain",
          },
          bridge: null,
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: /fix codex/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in to codex/i }),
    ).not.toBeInTheDocument();
    // The success/ready tick (the only `.text-success` element) is absent.
    expect(container.querySelector(".text-success")).toBeNull();
    // No bare "Update" affordance — the combined action is "Fix", not Update.
    expect(
      screen.queryByRole("button", { name: /^update$/i }),
    ).not.toBeInTheDocument();
  });

  it("Fix installs the missing component and applies pending updates in one pass", async () => {
    const user = userEvent.setup();
    installAgent.mockResolvedValue(undefined);
    updateAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(true);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "codex-acp",
          displayName: "Codex",
          binaryName: "codex-acp",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          id: "ai-agent-codex",
          label: "Codex",
          status: "warn",
          path: "/opt/homebrew/bin/codex",
          bridgePath: null,
          fixType: "bridge",
          installSource: "brew",
          installedVersion: "0.137.0",
          latestVersion: "0.139.0",
          updateAvailable: true,
          main: {
            installSource: "brew",
            installedVersion: "0.137.0",
            latestVersion: "0.139.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "brew upgrade codex",
            updateFixType: "updateMain",
          },
          bridge: null,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /fix codex/i }));

    // One click installs the missing bridge and brings the stale CLI current.
    // The install step must dispatch the *bridge* recipe (the check's
    // fixType="bridge"), not the static main-CLI recipe — otherwise codex-acp
    // is silently skipped while the already-present CLI is reinstalled.
    await waitFor(() => {
      expect(installAgent).toHaveBeenCalledWith("codex-acp", "bridge");
    });
    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith(
        "codex-acp",
        "updateMain",
        "brew upgrade codex",
      );
    });
    expect(authenticateAgent).not.toHaveBeenCalled();
  });

  it("installs both binaries of a from-scratch two-binary agent without chaining into auth", async () => {
    const user = userEvent.setup();
    installAgent.mockResolvedValue(undefined);
    authenticateAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(true);
    // From scratch the crate reports the main CLI first (fixType="command");
    // once it lands the now-visible bridge surfaces, then nothing remains.
    nextAgentInstallFix.mockResolvedValueOnce("bridge").mockResolvedValue(null);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "codex-acp",
          displayName: "Codex",
          binaryName: "codex-acp",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          id: "ai-agent-codex",
          label: "Codex",
          status: "fail",
          path: null,
          bridgePath: null,
          fixType: "command",
          main: null,
          bridge: null,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install codex/i }));

    // One click installs the main CLI then the now-visible bridge, in order.
    await waitFor(() => {
      expect(installAgent).toHaveBeenCalledTimes(2);
    });
    expect(installAgent).toHaveBeenNthCalledWith(1, "codex-acp", "command");
    expect(installAgent).toHaveBeenNthCalledWith(2, "codex-acp", "bridge");
    expect(authenticateAgent).not.toHaveBeenCalled();
  });

  it("installs a single-binary agent in one pass without a spurious bridge call", async () => {
    const user = userEvent.setup();
    installAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(true);
    // Single-binary agents (Copilot/Cursor) resolve their only binary; the
    // re-probe reports nothing further to install.
    nextAgentInstallFix.mockResolvedValue(null);

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "copilot-acp",
          displayName: "Copilot",
          binaryName: "copilot",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          id: "ai-agent-copilot",
          label: "Copilot",
          status: "fail",
          path: null,
          bridgePath: null,
          fixType: "command",
          main: null,
          bridge: null,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install copilot/i }));

    await waitFor(() => {
      expect(checkAgentInstalled).toHaveBeenCalledWith("copilot-acp");
    });
    expect(installAgent).toHaveBeenCalledTimes(1);
    expect(installAgent).toHaveBeenCalledWith("copilot-acp", "command");
    expect(installAgent).not.toHaveBeenCalledWith("copilot-acp", "bridge");
  });

  it("stops the install loop when the re-probe makes no progress", async () => {
    const user = userEvent.setup();
    installAgent.mockResolvedValue(undefined);
    checkAgentInstalled.mockResolvedValue(true);
    // An install that didn't take leaves the same fix pending; the ranFixTypes
    // guard must short-circuit so the loop terminates instead of spinning.
    nextAgentInstallFix.mockResolvedValue("command");

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "codex-acp",
          displayName: "Codex",
          binaryName: "codex-acp",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          id: "ai-agent-codex",
          label: "Codex",
          status: "fail",
          path: null,
          bridgePath: null,
          fixType: "command",
          main: null,
          bridge: null,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install codex/i }));

    // The loop runs the seeded recipe once and stops; the chain then reaches
    // the post-install verification rather than hanging on a repeating fix.
    await waitFor(() => {
      expect(checkAgentInstalled).toHaveBeenCalledWith("codex-acp");
    });
    expect(installAgent).toHaveBeenCalledTimes(1);
    expect(installAgent).toHaveBeenCalledWith("codex-acp", "command");
  });

  it("flags the missing ACP bridge in danger text when only the main CLI is installed", () => {
    // Same partial-install scenario as above: Codex's CLI is on PATH but the
    // codex-acp bridge is absent. The card body must name the missing bridge in
    // danger-colored text so it isn't mistaken for a healthy install, while
    // keeping the accurate "Installed via Homebrew" version line.
    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "codex-acp",
          displayName: "Codex",
          binaryName: "codex-acp",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          id: "ai-agent-codex",
          label: "Codex",
          status: "warn",
          path: "/opt/homebrew/bin/codex",
          bridgePath: null,
          fixType: "bridge",
          installSource: "brew",
          installedVersion: "0.137.0",
          latestVersion: "0.139.0",
          updateAvailable: true,
          main: {
            installSource: "brew",
            installedVersion: "0.137.0",
            latestVersion: "0.139.0",
            updateAvailable: true,
            selfUpdating: null,
            updateCommand: "brew upgrade codex",
            updateFixType: "updateMain",
          },
          bridge: null,
        })}
      />,
    );

    const missing = screen.getByText(/codex-acp not installed/i);
    expect(missing).toBeInTheDocument();
    expect(missing).toHaveClass("text-destructive");
    // The accurate install/version line stays alongside the warning.
    expect(
      screen.getByText("Installed via Homebrew · v0.137.0"),
    ).toBeInTheDocument();
  });

  it("does not flag a missing component for a fully installed provider", () => {
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

    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /update claude/i }));

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
