import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import type { AppShellContent as AppShellContentType } from "./ui/AppShellContent";

vi.mock("./hooks/useAppStartup", () => ({
  useAppStartup: () => ({ ready: true }),
}));

vi.mock("@/features/onboarding/hooks/useOnboardingGate", () => ({
  useOnboardingGate: () => ({
    shouldShowOnboarding: false,
    readiness: {},
    completeOnboarding: vi.fn(),
  }),
}));

vi.mock("@/features/sidebar/ui/Sidebar", () => ({
  Sidebar: ({
    onNavigate,
    onSettingsClick,
    onSettingsSectionChange,
  }: {
    onNavigate?: (view: string) => void;
    onSettingsClick?: () => void;
    onSettingsSectionChange?: (section: "providers") => void;
  }) => (
    <nav aria-label="mock sidebar">
      <button type="button" onClick={() => onNavigate?.("skills")}>
        Sidebar skills
      </button>
      <button type="button" onClick={() => onNavigate?.("automations")}>
        Sidebar automations
      </button>
      <button type="button" onClick={() => onNavigate?.("agents")}>
        Sidebar agents
      </button>
      <button type="button" onClick={onSettingsClick}>
        Sidebar settings
      </button>
      <button
        type="button"
        onClick={() => onSettingsSectionChange?.("providers")}
      >
        Sidebar providers
      </button>
    </nav>
  ),
}));

vi.mock("@/features/updates/ui/UpdateIndicator", () => ({
  UpdateIndicator: () => null,
}));

vi.mock("./ui/AppShellContent", () => ({
  AppShellContent: (({
    activeView,
    activeSettingsSection,
    activeSkillsSkillId,
    activeAgentsPersonaId,
    activeAutomationsRoute,
    onNavigateSkills,
    onNavigateAgents,
    onNavigateAutomations,
  }) => (
    <section>
      <div data-testid="active-view">{activeView}</div>
      <div data-testid="settings-section">{activeSettingsSection}</div>
      <div data-testid="skill-route">{activeSkillsSkillId ?? "list"}</div>
      <div data-testid="agent-route">{activeAgentsPersonaId ?? "list"}</div>
      <div data-testid="automation-route">
        {JSON.stringify(activeAutomationsRoute)}
      </div>
      <button type="button" onClick={() => onNavigateSkills("skill-1")}>
        Open skill detail
      </button>
      <button type="button" onClick={() => onNavigateAgents("persona-1")}>
        Open agent detail
      </button>
      <button
        type="button"
        onClick={() =>
          onNavigateAutomations({ surface: "history", selectedRun: null })
        }
      >
        Open automation history
      </button>
    </section>
  )) satisfies typeof AppShellContentType,
}));

describe("AppShell global navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("goes back and forward through Skills detail subroutes", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("list");
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");
    });
  });

  it("goes back and forward through Automations tabs", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation history" }),
    );

    expect(screen.getByTestId("automation-route")).toHaveTextContent(
      '"surface":"history"',
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("automation-route")).toHaveTextContent(
        '"surface":"overview"',
      );
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("automation-route")).toHaveTextContent(
        '"surface":"history"',
      );
    });
  });

  it("goes back and forward through Agents detail subroutes", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Open agent detail" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    expect(screen.getByTestId("agent-route")).toHaveTextContent("persona-1");

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("agent-route")).toHaveTextContent("list");
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("agent-route")).toHaveTextContent("persona-1");
    });
  });

  it("keeps Settings section navigation in the global stack", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar settings" }));
    await user.click(screen.getByRole("button", { name: "Sidebar providers" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "providers",
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("settings-section")).toHaveTextContent(
        "general",
      );
    });
  });
});
