import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentVersionInfo,
  DoctorCheck,
  DoctorReport,
} from "@/shared/api/doctor";
import { useAgentUpdatesAvailable } from "./useAgentUpdatesAvailable";

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
    path: "/Applications/Berd.app/Contents/Resources/acp/bin/claude-agent-acp",
    bridgePath: null,
    rawOutput: null,
    authStatus: "authenticated",
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

function info(overrides: Partial<AgentVersionInfo>): AgentVersionInfo {
  return {
    installSource: null,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: null,
    selfUpdating: null,
    updateCommand: null,
    updateFixType: null,
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

describe("useAgentUpdatesAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when the doctor report has no agent checks", async () => {
    runDoctor.mockResolvedValue(report([]));
    const { result } = renderHook(() => useAgentUpdatesAvailable(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(runDoctor).toHaveBeenCalled();
    });
    expect(result.current).toBe(false);
  });

  it("returns false when the only update is on a self-updating source", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-cursor",
          path: "/usr/local/bin/cursor-agent",
          installedVersion: "1.0.0",
          latestVersion: "1.1.0",
          updateAvailable: true,
          selfUpdating: true,
          installSource: "curlPipe",
        }),
      ]),
    );
    const { result } = renderHook(() => useAgentUpdatesAvailable(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(runDoctor).toHaveBeenCalled();
    });
    expect(result.current).toBe(false);
  });

  it("returns true when a user-managed agent's main CLI has an update", async () => {
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-codex",
          installedVersion: "1.4.0",
          latestVersion: "1.5.0",
          updateAvailable: true,
          installSource: "brew",
          main: info({
            installSource: "brew",
            installedVersion: "1.4.0",
            latestVersion: "1.5.0",
            updateAvailable: true,
            updateCommand: "brew upgrade codex",
            updateFixType: "updateMain",
          }),
        }),
      ]),
    );
    const { result } = renderHook(() => useAgentUpdatesAvailable(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("returns true when only the ACP bridge has an update", async () => {
    // Amp still ships its CLI and ACP bridge as separate binaries.
    runDoctor.mockResolvedValue(
      report([
        check({
          id: "ai-agent-amp",
          path: "/usr/local/bin/amp",
          bridgePath: "/usr/local/bin/amp-acp",
          main: info({
            installSource: "curlPipe",
            installedVersion: "1.0.0",
            selfUpdating: true,
          }),
          bridge: info({
            installSource: "npm",
            installedVersion: "0.34.0",
            latestVersion: "0.39.0",
            updateAvailable: true,
            updateCommand: "npm install -g amp-acp@latest",
            updateFixType: "updateBridge",
          }),
        }),
      ]),
    );
    const { result } = renderHook(() => useAgentUpdatesAvailable(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });
});
