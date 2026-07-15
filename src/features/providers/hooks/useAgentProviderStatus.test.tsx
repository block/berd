import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentProviderStatus } from "./useAgentProviderStatus";
import { useDefaultProviderReadinessStore } from "../stores/defaultProviderReadinessStore";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";

const mockBuildFeatures = vi.hoisted(() => ({ byoKeyProviders: false }));
const runDoctor = vi.fn();

vi.mock("@/shared/api/doctor", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/doctor")>(
    "@/shared/api/doctor",
  );
  return {
    ...actual,
    runDoctor: () => runDoctor(),
  };
});

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => mockBuildFeatures,
}));

function check(overrides: Partial<DoctorCheck>): DoctorCheck {
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

function report(checks: DoctorCheck[]): DoctorReport {
  return { checks };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useAgentProviderStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildFeatures.byoKeyProviders = false;
    useDefaultProviderReadinessStore.setState({
      readiness: null,
    });
  });

  it("marks agents installed and authenticated in the doctor report as ready", async () => {
    // The claude/codex bridges vendor the full harness CLI, so their checks
    // are single-binary: the bundled bridge reports under `path` and
    // `bridgePath` stays null.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-claude",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/claude-agent-acp",
          authStatus: "authenticated",
        }),
        check({
          id: "ai-agent-amp",
          status: "pass",
          path: "/usr/local/bin/amp-acp",
          authStatus: "notApplicable",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.readyAgentIds.has("goose")).toBe(true);
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(true);
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(true);
  });

  it("excludes agents whose auth probe reports notAuthenticated", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-claude",
          status: "warn",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/claude-agent-acp",
          authStatus: "notAuthenticated",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.readyAgentIds.has("claude-acp")).toBe(false);
    expect(result.current.readyAgentIds.has("goose")).toBe(true);
  });

  it("excludes agents whose binary is not on disk", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "warn",
          path: null,
          bridgePath: null,
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.readyAgentIds.has("codex-acp")).toBe(false);
  });

  it("refresh re-runs the doctor report", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-claude",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/claude-agent-acp",
          authStatus: "authenticated",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(true);
    const callCountBeforeRefresh = runDoctor.mock.calls.length;

    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-claude",
          status: "warn",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/claude-agent-acp",
          authStatus: "notAuthenticated",
        }),
      ]),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(runDoctor.mock.calls.length).toBeGreaterThan(callCountBeforeRefresh);
    await waitFor(() =>
      expect(result.current.readyAgentIds.has("claude-acp")).toBe(false),
    );
  });

  it("maps report state to agentReadiness for the model picker", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-claude",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/claude-agent-acp",
          authStatus: "authenticated",
        }),
        check({
          id: "ai-agent-codex",
          status: "warn",
          path: null,
          bridgePath: null,
        }),
        check({
          id: "ai-agent-cursor",
          status: "warn",
          path: "/usr/local/bin/cursor-agent",
          authStatus: "notAuthenticated",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("goose")).toBe("ready");
    expect(result.current.agentReadiness.get("claude-acp")).toBe("ready");
    expect(result.current.agentReadiness.get("codex-acp")).toBe(
      "not_installed",
    );
    expect(result.current.agentReadiness.get("cursor-agent")).toBe("not_ready");
  });

  it("marks supportsAuth-without-probe agents not_ready even when authStatus is notApplicable", async () => {
    // copilot-acp is supportsAuth=true, supportsAuthStatus=false — the crate
    // emits notApplicable here, but we treat it as pessimistic not_ready
    // until a real auth_status_command lands.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-copilot",
          status: "pass",
          path: "/usr/local/bin/copilot",
          authStatus: "notApplicable",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("copilot-acp")).toBe("not_ready");
    expect(result.current.readyAgentIds.has("copilot-acp")).toBe(false);
  });

  it("marks supportsAuth-without-probe agents not_ready when authStatus is null", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-copilot",
          status: "pass",
          path: "/usr/local/bin/copilot",
          authStatus: null,
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("copilot-acp")).toBe("not_ready");
  });

  it("marks codex-acp ready when its auth probe reports authenticated", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "pass",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/codex-acp",
          authStatus: "authenticated",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("codex-acp")).toBe("ready");
    expect(result.current.readyAgentIds.has("codex-acp")).toBe(true);
  });

  it("marks codex-acp not_ready when its auth probe reports notAuthenticated", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "warn",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/codex-acp",
          authStatus: "notAuthenticated",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("codex-acp")).toBe("not_ready");
    expect(result.current.readyAgentIds.has("codex-acp")).toBe(false);
  });

  it("keeps the served goose provider ready even when the goose CLI check fails", async () => {
    // The `ai-agent-goose` check probes the external `goose` CLI (`goose acp
    // --help`). A broken/stale CLI fails that probe, but the in-app Goose
    // provider is served by the bundled `goosed` sidecar and must not be gated
    // on it. So the seeded "ready" value survives and Goose stays selectable.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-goose",
          label: "goose CLI",
          status: "fail",
          message: "goose ACP subcommand not available — upgrade required",
          path: "/usr/local/bin/goose",
          bridgePath: null,
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("goose")).toBe("ready");
    expect(result.current.readyAgentIds.has("goose")).toBe(true);
  });

  it("keeps the served goose provider ready when the goose CLI check warns or has no path", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-goose",
          label: "goose CLI",
          status: "warn",
          path: null,
          bridgePath: null,
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("goose")).toBe("ready");
    expect(result.current.readyAgentIds.has("goose")).toBe(true);
  });

  it("keeps goose ready in BYO builds while default provider readiness is unknown", async () => {
    mockBuildFeatures.byoKeyProviders = true;
    useDefaultProviderReadinessStore.setState({
      readiness: { status: "unknown", error: "temporarily unavailable" },
    });
    runDoctor.mockResolvedValue(report([]));

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("goose")).toBe("ready");
    expect(result.current.readyAgentIds.has("goose")).toBe(true);
  });

  it("marks goose not_ready in BYO builds when default provider setup is required", async () => {
    mockBuildFeatures.byoKeyProviders = true;
    useDefaultProviderReadinessStore.setState({
      readiness: { status: "needs_setup", reason: "missing_defaults" },
    });
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-goose",
          label: "goose CLI",
          status: "fail",
          path: null,
          bridgePath: null,
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("goose")).toBe("not_ready");
    expect(result.current.readyAgentIds.has("goose")).toBe(false);
  });

  it("still surfaces the goose CLI check via agentChecks for the version readout", async () => {
    // Skipping the goose readiness override must not drop the check itself:
    // the AI Providers tab reads the goose version line from `agentChecks`.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-goose",
          label: "goose CLI",
          status: "fail",
          path: "/usr/local/bin/goose",
          installedVersion: "1.7.0",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    const gooseCheck = result.current.agentChecks.get("goose");
    expect(gooseCheck?.id).toBe("ai-agent-goose");
    expect(gooseCheck?.installedVersion).toBe("1.7.0");
  });

  it("still gates non-goose agents whose CLI check fails", async () => {
    // The goose exemption is scoped to the served backend only — other agents
    // remain gated on their doctor health as before.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-claude",
          status: "fail",
          path: null,
          bridgePath: null,
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("claude-acp")).toBe(
      "not_installed",
    );
    expect(result.current.readyAgentIds.has("claude-acp")).toBe(false);
  });

  it("marks a bundled agent ready from the crate-stamped bundled readout", async () => {
    // The bundled bridge vendors the harness CLI and is the check's only
    // binary: it resolves under `path` from Berd's bundled tools dir, the
    // crate stamps the readout bundled, and `bridgePath` stays null.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "pass",
          path: "/Applications/Berd.app/Contents/Resources/acp/bin/codex-acp",
          bridgePath: null,
          authStatus: "authenticated",
          installSource: "bundled",
          installedVersion: "0.142.5",
          main: {
            installSource: "bundled",
            installedVersion: "0.142.5",
            latestVersion: null,
            updateAvailable: null,
            selfUpdating: null,
            updateCommand: null,
            updateFixType: null,
            bundled: true,
          },
          bridge: null,
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("codex-acp")).toBe("ready");
    expect(result.current.readyAgentIds.has("codex-acp")).toBe(true);
  });

  it("marks a bundled-bridge agent not_installed when its binary fails to resolve", async () => {
    // The bundle is broken (packaging regression, wiped resources) and no
    // global fallback is installed: the check resolves nothing and offers the
    // bridge npm package as the install fix. Sessions cannot spawn without
    // the bridge, so readiness must surface not_installed with remediation.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "fail",
          path: null,
          bridgePath: null,
          fixType: "command",
          fixCommand: "npm install -g @agentclientprotocol/codex-acp",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("codex-acp")).toBe(
      "not_installed",
    );
    expect(result.current.readyAgentIds.has("codex-acp")).toBe(false);
  });

  it("ignores a stray bridgePath for bundled-bridge agents", async () => {
    // Bundled providers gate on `path` alone — the bridge *is* the binary. A
    // report with only `bridgePath` set means the provider's binary did not
    // resolve, so it must not read as installed.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "warn",
          path: null,
          bridgePath:
            "/Applications/Berd.app/Contents/Resources/acp/bin/codex-acp",
          authStatus: "authenticated",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("codex-acp")).toBe(
      "not_installed",
    );
    expect(result.current.readyAgentIds.has("codex-acp")).toBe(false);
  });

  it("marks a two-binary agent not_installed when its ACP bridge is missing", async () => {
    // Amp still ships its CLI and ACP bridge separately: a present `amp` CLI
    // with a missing bridge reports fixType="bridge" and must surface the
    // bridge Install action instead of reading as installed.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-amp",
          status: "warn",
          path: "/usr/local/bin/amp",
          bridgePath: null,
          fixType: "bridge",
          authStatus: "authenticated",
        }),
      ]),
    );

    const { result } = renderHook(() => useAgentProviderStatus(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agentReadiness.get("amp-acp")).toBe("not_installed");
    expect(result.current.readyAgentIds.has("amp-acp")).toBe(false);
  });
});
