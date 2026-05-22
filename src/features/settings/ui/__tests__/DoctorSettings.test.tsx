import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  return renderWithProviders(
    <TopBarActionsProvider>
      <DoctorSettings />
      <TopBarActionsSurface />
    </TopBarActionsProvider>,
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

  it("does not render the agents category", async () => {
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
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.queryByText("Codex")).toBeNull();
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
    expect(output).not.toContain("Agents (agents)");
    expect(output).not.toContain("Codex");
  });
});
