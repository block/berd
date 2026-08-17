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

  it("opens expandable details from an actionable custom status", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "goose",
          displayName: "Goose",
          status: "built_in",
          binaryName: undefined,
        })}
        expandedContent={<div>Model provider setup</div>}
        statusIndicator={<span>Connect a model provider</span>}
        statusIndicatorOpensDetails
      />,
    );

    expect(screen.queryByText("Model provider setup")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Connect a model provider" }),
    );

    expect(screen.getByText("Model provider setup")).toBeVisible();
  });

  it("renders the expandable Goose harness as a settings row", () => {
    const { container } = renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "goose",
          displayName: "Goose",
          status: "built_in",
        })}
        expandedContent={<div>Model providers</div>}
        expandableLabel="Model providers"
        collapsedSummary="Databricks"
        showDisclosure
      />,
    );

    expect(
      container.querySelector('[data-slot="settings-row"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="expandable-card"]'),
    ).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", {
      name: "Expand Model providers details",
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    const controlledId = disclosure.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    const controlledRegion = document.getElementById(controlledId ?? "");
    expect(controlledRegion).toBeInTheDocument();
    expect(controlledRegion).toHaveAttribute("aria-hidden", "true");
    expect(controlledRegion).toHaveAttribute("inert");
  });

  it("updates the Goose disclosure action label as it expands and collapses", async () => {
    const user = userEvent.setup();

    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "goose",
          displayName: "Goose",
          status: "built_in",
        })}
        expandedContent={<div>Model provider setup</div>}
        expandableLabel="Model providers"
        collapsedSummary="Databricks"
        showDisclosure
      />,
    );

    const expandButton = screen.getByRole("button", {
      name: "Expand Model providers details",
    });
    expect(expandButton).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByText("Model provider setup").closest("[aria-hidden='true']"),
    ).toBeInTheDocument();

    await user.click(expandButton);

    const collapseButton = screen.getByRole("button", {
      name: "Collapse Model providers details",
    });
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    const controlledRegion = document.getElementById(
      collapseButton.getAttribute("aria-controls") ?? "",
    );
    expect(controlledRegion).toBeInTheDocument();
    expect(controlledRegion).toHaveAttribute("aria-hidden", "false");
    expect(controlledRegion).not.toHaveAttribute("inert");
    expect(
      screen.getByText("Model provider setup").closest("[aria-hidden='true']"),
    ).not.toBeInTheDocument();

    await user.click(collapseButton);

    const collapsedButton = screen.getByRole("button", {
      name: "Expand Model providers details",
    });
    expect(collapsedButton).toHaveAttribute("aria-expanded", "false");
    expect(controlledRegion).toHaveAttribute("aria-hidden", "true");
    expect(controlledRegion).toHaveAttribute("inert");
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

  it("uses a settings row and neutral outline actions outside Goose", () => {
    const { container } = renderCard(
      <AgentProviderCard
        provider={createProvider({
          status: "not_installed",
          supportsInstall: true,
          supportsAuth: true,
        })}
        statusLoading={false}
        readiness={"not_installed" satisfies AgentProviderReadiness}
      />,
    );

    expect(
      container.querySelector('[data-slot="settings-row"]'),
    ).toBeInTheDocument();
    const install = screen.getByRole("button", { name: /install claude/i });
    expect(install).not.toHaveClass("text-warning");
  });

  it("aligns row details with the provider title when an icon is present", () => {
    const { container } = renderCard(
      <AgentProviderCard
        provider={createProvider()}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          installSource: "brew",
          installedVersion: "1.2.3",
        })}
      />,
    );

    expect(
      container.querySelector('[data-slot="settings-row-details"]'),
    ).toHaveClass("ml-10");
  });

  it("uses an outlined sign-in action", () => {
    renderCard(
      <AgentProviderCard
        provider={createProvider()}
        statusLoading={false}
        readiness={"not_ready" satisfies AgentProviderReadiness}
      />,
    );

    const signIn = screen.getByRole("button", { name: /sign in/i });
    expect(signIn).toHaveClass("border", "border-input");
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
        updateFixTypes: [],
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
        updateFixTypes: [],
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
        updateFixTypes: [],
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
        updateFixTypes: [],
        verifyInstall: true,
      });
    });
    expect(clearAgentSetupStatus).not.toHaveBeenCalled();
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
      expect(startAgentSetup).toHaveBeenCalledWith("claude-acp", "update", {
        installFixType: null,
        updateFixTypes: ["updateMain"],
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
        updateFixTypes: ["updateMain"],
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
        updateFixTypes: [],
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
        updateFixTypes: ["updateMain"],
        verifyInstall: true,
      });
    });
  });

  it("bundled bridges install with the bridge npm recipe and carry the bundled gate", async () => {
    const user = userEvent.setup();

    // The bundled bridge vendors the full harness CLI, so the check is
    // single-binary: a broken/absent bundle reports fixType="command", whose
    // crate recipe installs the bridge npm package (a global fallback copy).
    renderCard(
      <AgentProviderCard
        provider={createProvider({
          id: "codex-acp",
          displayName: "Codex",
          binaryName: "codex-acp",
          supportsInstall: true,
          supportsAuth: true,
          supportsAuthStatus: true,
          bundledBridge: true,
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

    await waitFor(() => {
      expect(startAgentSetup).toHaveBeenCalledWith("codex-acp", "install", {
        installFixType: "command",
        updateFixTypes: [],
        verifyInstall: true,
        // The backend's post-install verification mirrors the readiness gate:
        // a bundled-bridge provider must resolve its only binary under `path`,
        // so a still-broken bundle fails with a message instead of a success
        // the card immediately contradicts.
        bundledBridge: true,
      });
    });
  });

  it("shows a bundled bridge as ready with no update affordance", () => {
    // The crate stamps bundled readouts (installSource "bundled") and derives
    // no update command for them — the bundled copy updates with Berd itself,
    // so a newer npm release must not surface an Update button that a global
    // `npm install -g` could never make effective.
    const { container } = renderCard(
      <AgentProviderCard
        provider={createProvider({
          binaryName: "claude-agent-acp",
          supportsInstall: true,
          supportsAuth: false,
          supportsAuthStatus: false,
          bundledBridge: true,
        })}
        statusLoading={false}
        readiness={"ready" satisfies AgentProviderReadiness}
        versionCheck={createVersionCheck({
          status: "pass",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/claude-agent-acp",
          bridgePath: null,
          installSource: "bundled",
          installedVersion: "2.1.202",
          latestVersion: "2.1.210",
          updateAvailable: null,
          main: {
            installSource: "bundled",
            installedVersion: "2.1.202",
            latestVersion: "2.1.210",
            updateAvailable: null,
            selfUpdating: null,
            updateCommand: null,
            updateFixType: null,
            bundled: true,
          },
          bridge: null,
        })}
      />,
    );

    // Ready tick, no Update button.
    expect(container.querySelector(".text-success")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /update claude/i }),
    ).not.toBeInTheDocument();

    expect(
      screen.getByText("Installed via app bundle · v2.1.202"),
    ).toBeInTheDocument();
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
        updateFixTypes: [],
        verifyInstall: true,
      });
    });
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
        updateFixTypes: ["updateMain", "updateBridge"],
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

  it("auto-starts installation exactly once for a missing provider", async () => {
    const provider = createProvider({
      supportsInstall: true,
      supportsAuth: false,
      supportsAuthStatus: false,
    });
    const { rerender } = renderCard(
      <AgentProviderCard
        provider={provider}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );

    await waitFor(() => expect(startAgentSetup).toHaveBeenCalledOnce());
    rerender(
      <AgentProviderCard
        provider={provider}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );
    expect(startAgentSetup).toHaveBeenCalledOnce();
  });

  it("does not restart an automatic install across a pending remount", async () => {
    let resolveStart: ((operation: AgentSetupOperation) => void) | undefined;
    startAgentSetup.mockImplementationOnce(
      () =>
        new Promise<AgentSetupOperation>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const provider = createProvider({ supportsInstall: true });
    const first = renderCard(
      <AgentProviderCard
        provider={provider}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );
    await waitFor(() => expect(startAgentSetup).toHaveBeenCalledOnce());
    first.unmount();

    renderCard(
      <AgentProviderCard
        provider={provider}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );
    expect(startAgentSetup).toHaveBeenCalledOnce();

    resolveStart?.(makeOperation());
    await waitForRunning(provider.id);
  });

  it("surfaces an automatic install launch failure", async () => {
    startAgentSetup.mockRejectedValueOnce(new Error("backend unavailable"));
    renderCard(
      <AgentProviderCard
        provider={createProvider({ supportsInstall: true })}
        statusLoading={false}
        readiness="not_installed"
        autoStartInstall
        autoInstallProgressOnly
      />,
    );

    expect(await screen.findByText("Setup hit a snag.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
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
