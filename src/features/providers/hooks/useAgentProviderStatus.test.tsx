import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentProviderStatus } from "./useAgentProviderStatus";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";

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
  });

  it("marks agents installed and authenticated in the doctor report as ready", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-claude",
          path: "/usr/local/bin/claude",
          bridgePath: "/usr/local/bin/claude-agent-acp",
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
          path: "/usr/local/bin/claude",
          bridgePath: "/usr/local/bin/claude-agent-acp",
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
          path: "/usr/local/bin/claude",
          bridgePath: "/usr/local/bin/claude-agent-acp",
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
          path: "/usr/local/bin/claude",
          bridgePath: "/usr/local/bin/claude-agent-acp",
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
          path: "/usr/local/bin/claude",
          bridgePath: "/usr/local/bin/claude-agent-acp",
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
          path: "/usr/local/bin/codex",
          bridgePath: "/usr/local/bin/codex-acp",
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
          path: "/usr/local/bin/codex",
          bridgePath: "/usr/local/bin/codex-acp",
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

  it("does not require a user-installed codex-acp bridge when Berd bundles it", async () => {
    // Main CLI (Homebrew codex) is installed and even has an update available;
    // the bundled bridge dir is on the doctor PATH, so the crate resolves
    // bridgePath to the bundled binary and does not flag fixType="bridge".
    // Readiness is gated on the real Codex CLI and auth state instead of
    // offering a bridge install.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "warn",
          path: "/opt/homebrew/bin/codex",
          bridgePath:
            "/Applications/Berd.app/Contents/Resources/acp/bin/codex-acp",
          authStatus: "authenticated",
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

  it("marks a bundled-bridge agent not_installed when the bundled bridge fails to resolve", async () => {
    // The main CLI is healthy, but the bundled bridge is missing (packaging
    // regression, wiped resources): the crate leaves bridgePath null and flags
    // fixType="bridge". Sessions cannot spawn without the bridge, so readiness
    // must not report "ready" — surface not_installed with its remediation.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          status: "warn",
          path: "/opt/homebrew/bin/codex",
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

    expect(result.current.agentReadiness.get("codex-acp")).toBe(
      "not_installed",
    );
    expect(result.current.readyAgentIds.has("codex-acp")).toBe(false);
  });

  it("requires the main CLI for bundled-bridge agents", async () => {
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
});
