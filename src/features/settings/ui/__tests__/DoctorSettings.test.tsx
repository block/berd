import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders } from "@/test/render";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import {
  DoctorSettings,
  formatDebugReport,
} from "@/features/settings/ui/DoctorSettings";

function TopBarActionsSurface() {
  const actions = useTopBarActions();
  return <div data-testid="top-bar-actions">{actions}</div>;
}

function renderDoctor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <TopBarActionsProvider>
        <DoctorSettings />
        <TopBarActionsSurface />
      </TopBarActionsProvider>
    </QueryClientProvider>,
  );
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const writeText = vi.fn();

function check(overrides: Partial<DoctorCheck>): DoctorCheck {
  return {
    id: "git",
    label: "Git",
    status: "pass",
    message: "ok",
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
    category: "tools",
    categoryLabel: "Tools",
    ...overrides,
  };
}

function report(checks: DoctorCheck[]): DoctorReport {
  return { checks };
}

describe("DoctorSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("renders backend-provided categories without category-specific UI wiring", async () => {
    mockedInvoke.mockResolvedValue(
      report([
        check({
          id: "git",
          label: "Git",
          category: "tools",
          categoryLabel: "Tools",
        }),
        check({
          id: "local-env",
          label: "Local Environment",
          category: "environment",
          categoryLabel: "Environment",
        }),
      ]),
    );

    renderDoctor();

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeVisible();
    expect(screen.getByText("Git")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Environment" })).toBeVisible();
    expect(screen.getByText("Local Environment")).toBeVisible();
  });

  it("copies a report grouped by backend categories", async () => {
    mockedInvoke.mockResolvedValue(
      report([
        check({
          id: "git",
          label: "Git",
          category: "tools",
          categoryLabel: "Tools",
        }),
        check({
          id: "permissions",
          label: "Permissions",
          status: "warn",
          message: "Needs access",
          category: "permissions",
          categoryLabel: "Permissions",
          rawOutput: "missing entitlement",
        }),
      ]),
    );

    renderDoctor();
    await screen.findByRole("heading", { name: "Permissions" });

    fireEvent.click(screen.getByRole("button", { name: /copy report/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain("Tools (tools)");
    expect(copied).toContain("Permissions (permissions)");
    expect(copied).toContain("missing entitlement");
  });

  it("keeps checks in their returned category order", async () => {
    mockedInvoke.mockResolvedValue(
      report([
        check({
          id: "integration",
          label: "Integration",
          category: "integrations",
          categoryLabel: "Integrations",
        }),
        check({
          id: "git",
          label: "Git",
          category: "tools",
          categoryLabel: "Tools",
        }),
      ]),
    );

    renderDoctor();

    await screen.findByText("Integration");
    const headings = screen.getAllByRole("heading", { level: 4 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Integrations",
      "Tools",
    ]);
  });

  it("hides the agents category (rendered on the AI providers page instead)", async () => {
    mockedInvoke.mockResolvedValue(
      report([
        check({
          id: "git",
          label: "Git",
          category: "tools",
          categoryLabel: "Tools",
        }),
        check({
          id: "ai-agent-codex",
          label: "Codex",
          category: "agents",
          categoryLabel: "Agents",
        }),
      ]),
    );

    renderDoctor();

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Agents" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
  });

  it("renders the synthetic timeout report", async () => {
    mockedInvoke.mockResolvedValue(
      report([
        check({
          id: "doctor-timeout",
          label: "Doctor Checks",
          status: "warn",
          message: "Doctor timed out after 60 seconds",
          category: "environment-health",
          categoryLabel: "Environment Health",
        }),
      ]),
    );

    renderDoctor();

    expect(
      await screen.findByRole("heading", { name: "Environment Health" }),
    ).toBeVisible();
    expect(screen.getByText("Doctor Checks")).toBeVisible();
    expect(screen.getByText("Doctor timed out after 60 seconds")).toBeVisible();
  });
});

describe("formatDebugReport", () => {
  it("includes visible category headings", () => {
    const output = formatDebugReport(
      report([
        check({
          id: "git",
          label: "Git",
          category: "tools",
          categoryLabel: "Tools",
        }),
        check({
          id: "ai-agent-codex",
          label: "Codex",
          category: "agents",
          categoryLabel: "Agents",
        }),
      ]),
    );

    expect(output).toContain("Tools (tools)");
    expect(output).toContain("Agents (agents)");
    expect(output).toContain("Codex");
  });

  it("includes install source, versions, and update availability", () => {
    const output = formatDebugReport(
      report([
        check({
          id: "ai-agent-claude",
          label: "Claude Code",
          category: "agents",
          categoryLabel: "Agents",
          authStatus: "notAuthenticated",
          main: {
            installSource: "curlPipe",
            installedVersion: "1.4.0",
            latestVersion: "1.4.0",
            updateAvailable: false,
            selfUpdating: true,
          },
          bridge: {
            installSource: "npm",
            installedVersion: "0.34.0",
            latestVersion: "0.39.0",
            updateAvailable: true,
            selfUpdating: false,
            updateCommand: "npm install -g claude-agent-acp@latest",
            updateFixType: "updateBridge",
          },
        }),
      ]),
    );

    expect(output).toContain("Auth status: notAuthenticated");
    expect(output).toContain("Install source (main): curlPipe");
    expect(output).toContain("Installed version (main): 1.4.0");
    expect(output).toContain("Self-updating (main): yes");
    expect(output).toContain("Install source (bridge): npm");
    expect(output).toContain("Installed version (bridge): 0.34.0");
    expect(output).toContain("Latest version (bridge): 0.39.0");
    expect(output).toContain("Update available (bridge): yes");
  });
});
