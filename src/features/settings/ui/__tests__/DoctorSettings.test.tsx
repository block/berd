import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders } from "@/test/render";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import {
  DoctorSettings,
  formatDebugReport,
} from "@/features/settings/ui/DoctorSettings";

function renderDoctor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <DoctorSettings open onOpenChange={() => {}} />
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

    const toolsHeading = await screen.findByRole("heading", {
      name: "Tools",
      level: 2,
    });
    expect(toolsHeading).toBeVisible();
    expect(toolsHeading).toHaveClass("text-base", "font-medium");
    expect(screen.getByText("Git")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Environment", level: 2 }),
    ).toBeVisible();
    expect(screen.getByText("Local Environment")).toBeVisible();
    expect(toolsHeading.closest('[data-slot="settings-sections"]')).toHaveClass(
      "space-y-11",
    );
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

  it("disables copy report while a rerun is in flight", async () => {
    const user = userEvent.setup();
    mockedInvoke.mockResolvedValue(
      report([
        check({
          id: "git",
          label: "Git",
          category: "tools",
          categoryLabel: "Tools",
        }),
      ]),
    );

    renderDoctor();
    await screen.findByRole("heading", { name: "Tools" });

    const copyButton = screen.getByRole("button", { name: /copy report/i });
    expect(copyButton).toBeEnabled();

    // React Query keeps the previous report visible during a rerun
    // (`loading` goes true, `report` stays populated with the stale data),
    // so without the fix this button would stay enabled and let a user
    // export the pre-rerun report as if it were current.
    mockedInvoke.mockImplementation(() => new Promise(() => {}));
    await user.click(screen.getByRole("button", { name: /run again/i }));

    await waitFor(() => expect(copyButton).toBeDisabled());
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
    // Exclude the dialog's own "Doctor" title -- DialogTitle renders as an
    // <h2> too (Radix's default), so an unscoped level-2 query would pick it
    // up alongside the check-group category headings this test cares about.
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .filter(
        (heading) => heading.getAttribute("data-slot") !== "dialog-title",
      );
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
    // Amp still ships its CLI and ACP bridge as separate binaries, so it
    // exercises both readout slots.
    const output = formatDebugReport(
      report([
        check({
          id: "ai-agent-amp",
          label: "Amp",
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
            updateCommand: "npm install -g amp-acp@latest",
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
