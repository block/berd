import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import { AgentProviderCard } from "../AgentProviderCard";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { DoctorCheck } from "@/shared/api/doctor";
import type { AgentSetupOperation } from "@/features/providers/api/agentSetup";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import type { ProviderDisplayInfo } from "@/shared/types/providers";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import { AGENT_SETUP_FAILURE_SIMULATION_KEY } from "@/features/providers/lib/agentSetupFailureSimulation";

// Setup progress is now backend-owned: the card kicks an operation off through
// the store (`startAgentSetup`) and renders the snapshot the store mirrors from
// `agent-setup:state`. The multi-step install loop / update ordering / verify
// chain itself lives in Rust (`agent_setup.rs` unit tests cover its
// transitions), so these tests assert the *plan* the card builds and the view
// it renders from the store, not the in-card orchestration that used to exist.
const startAgentSetup = vi.fn();
const getAgentSetupStatus = vi.fn();
const listAgentSetupStatus = vi.fn();
const clearAgentSetupStatus = vi.fn();
const onAgentSetupState = vi.fn();

vi.mock("@/features/providers/api/agentSetup", () => ({
  startAgentSetup: (...args: unknown[]) => startAgentSetup(...args),
  getAgentSetupStatus: (...args: unknown[]) => getAgentSetupStatus(...args),
  listAgentSetupStatus: (...args: unknown[]) => listAgentSetupStatus(...args),
  clearAgentSetupStatus: (...args: unknown[]) => clearAgentSetupStatus(...args),
  onAgentSetupState: (...args: unknown[]) => onAgentSetupState(...args),
}));

const rerunDoctorReport = vi.fn();
const invalidateDoctorReport = vi.fn();

vi.mock("@/shared/api/useDoctorReport", () => ({
  rerunDoctorReport: (...args: unknown[]) => rerunDoctorReport(...args),
  invalidateDoctorReport: (...args: unknown[]) =>
    invalidateDoctorReport(...args),
}));

function makeOperation(
  overrides: Partial<AgentSetupOperation> = {},
): AgentSetupOperation {
  return {
    action: "install",
    phase: "installing",
    status: "running",
    output: [],
    error: null,
    ...overrides,
  };
}

// Drive the store the way the backend's `agent-setup:state` event would.
function emitOperation(providerId: string, operation: AgentSetupOperation) {
  act(() => {
    useAgentSetupStore.getState().setOperation(providerId, operation);
  });
}

// `startSetup` optimistically mirrors the backend's seeded running snapshot.
// Wait for that to land before emitting a terminal state, so the later
// `agent-setup:state` event isn't clobbered by the in-flight optimistic write.
async function waitForRunning(providerId: string) {
  await waitFor(() =>
    expect(useAgentSetupStore.getState().getStatus(providerId)?.status).toBe(
      "running",
    ),
  );
}

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
    // The backend seeds a running snapshot and returns it; the store mirrors it.
    startAgentSetup.mockResolvedValue(makeOperation());
    clearAgentSetupStatus.mockResolvedValue(undefined);
    listAgentSetupStatus.mockResolvedValue([]);
    onAgentSetupState.mockResolvedValue(vi.fn());
    rerunDoctorReport.mockResolvedValue(undefined);
    invalidateDoctorReport.mockResolvedValue(undefined);
    // Each test starts with an empty backend-state mirror.
    useAgentSetupStore.setState({ operations: new Map() });
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
    // Nothing is kicked off just by rendering.
    expect(startAgentSetup).not.toHaveBeenCalled();
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
    expect(startAgentSetup).not.toHaveBeenCalled();
  });

  it("restores an in-progress operation from the store on mount", () => {
    // A reloaded / remounted card reads the backend-owned snapshot straight
    // from the store: spinner + accumulated output, no click required.
    useAgentSetupStore.setState({
      operations: new Map([
        [
          "claude-acp",
          makeOperation({
            output: ["npm install -g claude…", "added 1 package"],
          }),
        ],
      ]),
    });

    renderCard(
      <AgentProviderCard
        provider={createProvider({ supportsAuth: false })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      screen.getByRole("status", { name: "Setup in progress" }),
    ).toBeInTheDocument();
    expect(screen.getByText("added 1 package")).toBeInTheDocument();
  });

  it("signs in an installed-but-unauthenticated agent", async () => {
    const user = userEvent.setup();

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
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "auth", {
        installFixType: null,
        updateCommands: [],
        verifyInstall: true,
      });
    });
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

  it("starts an install (CLI recipe, no updates) without sign in when not installed", async () => {
    const user = userEvent.setup();

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
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "install", {
        installFixType: "command",
        updateCommands: [],
        verifyInstall: true,
      });
    });
  });

  it("renders the backend-reported install verification failure with troubleshooting", async () => {
    const user = userEvent.setup();
    const onStartTroubleshootingChat = vi.fn();

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
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "install", {
        installFixType: "command",
        updateCommands: [],
        verifyInstall: true,
      });
    });

    // The backend reports the verification-failure sentinel; the card localizes
    // it and offers troubleshooting.
    await waitForRunning("claude-acp");
    emitOperation(
      "claude-acp",
      makeOperation({
        phase: "idle",
        status: "failed",
        error: "installVerificationFailed",
      }),
    );

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
    await waitFor(() => expect(startAgentSetup).toHaveBeenCalled());

    // The backend streamed npm output and failed with a command error.
    await waitForRunning("claude-acp");
    emitOperation(
      "claude-acp",
      makeOperation({
        phase: "idle",
        status: "failed",
        error: "Command exited with code 1",
        output: [
          "npm error code EEXIST",
          "npm error path /opt/homebrew/bin/claude",
          "npm error EEXIST: file already exists",
        ],
      }),
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

  it("retries a failed setup without clearing the backend entry first", async () => {
    const user = userEvent.setup();

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
      />,
    );

    emitOperation(
      "claude-acp",
      makeOperation({
        action: "install",
        phase: "idle",
        status: "failed",
        error: "Command exited with code 1",
      }),
    );

    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    clearAgentSetupStatus.mockClear();
    startAgentSetup.mockClear();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "install", {
        installFixType: "command",
        updateCommands: [],
        verifyInstall: true,
      });
    });
    expect(clearAgentSetupStatus).not.toHaveBeenCalled();
  });

  it("surfaces install source and version from the shared report", async () => {
    const user = userEvent.setup();

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

    await user.click(screen.getByRole("button", { name: /claude provider/i }));

    expect(
      screen.getByText("Installed via Homebrew · v1.2.3"),
    ).toBeInTheDocument();
  });

  it("wires the top-right Update button to the per-readout update command", async () => {
    const user = userEvent.setup();

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

    await user.click(screen.getByRole("button", { name: /claude provider/i }));
    expect(screen.getByText("Update available → v1.3.0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /update claude/i }));

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "update", {
        installFixType: null,
        updateCommands: [
          {
            fixType: "updateMain",
            command: "npm install -g @anthropic-ai/claude-code@latest",
          },
        ],
        verifyInstall: true,
      });
    });

    // On the backend reporting success we re-run the freshness pass (not a bare
    // invalidate) so the version badges repopulate instead of blanking out.
    await waitForRunning("claude-acp");
    emitOperation(
      "claude-acp",
      makeOperation({ action: "update", status: "succeeded", phase: "idle" }),
    );
    await waitFor(() => {
      expect(rerunDoctorReport).toHaveBeenCalled();
    });
    expect(invalidateDoctorReport).not.toHaveBeenCalled();
  });

  it("keeps the setup retry surface when the post-success doctor refresh fails", async () => {
    const onProviderReady = vi.fn();
    rerunDoctorReport.mockRejectedValueOnce(new Error("doctor refresh failed"));

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
        onProviderReady={onProviderReady}
      />,
    );

    emitOperation(
      "claude-acp",
      makeOperation({ action: "install", status: "succeeded", phase: "idle" }),
    );

    await waitFor(() => {
      expect(rerunDoctorReport).toHaveBeenCalled();
    });
    expect(onProviderReady).not.toHaveBeenCalled();
    expect(clearAgentSetupStatus).not.toHaveBeenCalled();
    expect(useAgentSetupStore.getState().getStatus("claude-acp")).toMatchObject(
      {
        action: "install",
        status: "failed",
        error: "doctor refresh failed",
      },
    );
    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^retry$/i }),
    ).toBeInTheDocument();
  });

  it("renders update and sign in as separate actions for an unauthenticated stale agent", async () => {
    const user = userEvent.setup();

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
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "update", {
        installFixType: null,
        updateCommands: [
          {
            fixType: "updateMain",
            command: "npm install -g @anthropic-ai/claude-code@latest",
          },
        ],
        verifyInstall: true,
      });
    });

    // The update finished and its terminal entry was consumed, so both the
    // update and sign-in actions return; sign in is its own separate action.
    await waitForRunning("claude-acp");
    act(() => {
      useAgentSetupStore.getState().clear("claude-acp");
    });

    await user.click(
      await screen.findByRole("button", { name: /sign in to claude/i }),
    );

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "auth", {
        installFixType: null,
        updateCommands: [],
        verifyInstall: true,
      });
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

  it("Fix builds a plan that installs the missing bridge and applies pending updates", async () => {
    const user = userEvent.setup();

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

    // The plan seeds the *bridge* recipe (the check's fixType="bridge") so the
    // backend installs codex-acp rather than reinstalling the present CLI, and
    // carries the pending update so the stale CLI is brought current too. The
    // install-loop ordering itself is covered by the Rust unit tests.
    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("codex-acp", "install", {
        installFixType: "bridge",
        updateCommands: [
          { fixType: "updateMain", command: "brew upgrade codex" },
        ],
        verifyInstall: true,
      });
    });
  });

  it("seeds the install plan with the main-CLI recipe for a from-scratch agent", async () => {
    const user = userEvent.setup();

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

    // From scratch the plan seeds "command"; the backend's install loop then
    // re-probes and installs the now-visible bridge (Rust-tested).
    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("codex-acp", "install", {
        installFixType: "command",
        updateCommands: [],
        verifyInstall: true,
      });
    });
  });

  it("flags the missing ACP bridge in danger text when only the main CLI is installed", async () => {
    const user = userEvent.setup();

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

    await user.click(screen.getAllByRole("button", { name: /codex/i })[0]);

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

  it("carries every actionable readout in the update plan when main and bridge are stale", async () => {
    const user = userEvent.setup();

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
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "update", {
        installFixType: null,
        updateCommands: [
          {
            fixType: "updateMain",
            command: "curl -fsSL https://example.com/install.sh | bash",
          },
          {
            fixType: "updateBridge",
            command: "npm install -g claude-agent-acp@latest",
          },
        ],
        verifyInstall: true,
      });
    });
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

    // The dev hook injects a real terminal failure into the store without
    // touching the backend.
    expect(startAgentSetup).not.toHaveBeenCalled();
    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/claude-agent-acp/i)).toBeInTheDocument();
  });
});
