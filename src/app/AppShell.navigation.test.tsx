import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { AppShell } from "./AppShell";
import type { AppShellContent as AppShellContentType } from "./ui/AppShellContent";

const mockAcpCreateSession = vi.hoisted(() => vi.fn());

vi.mock("./hooks/useAppStartup", () => ({
  useAppStartup: () => ({ ready: true }),
}));

vi.mock("@/features/migration/hooks/useMigrationGate", () => ({
  useMigrationGate: () => ({ status: "ready", retry: vi.fn() }),
}));

vi.mock("@/features/migration/hooks/useDefaultModelGate", () => ({
  useDefaultModelGate: () => ({ status: "ok", retry: vi.fn() }),
}));

vi.mock("@/features/sidebar/ui/Sidebar", () => ({
  Sidebar: ({
    onNavigate,
    onNewChat,
    onSettingsClick,
    onSettingsSectionChange,
  }: {
    onNavigate?: (view: string) => void;
    onNewChat?: () => void;
    onSettingsClick?: () => void;
    onSettingsSectionChange?: (section: "providers") => void;
  }) => (
    <nav aria-label="mock sidebar">
      <button type="button" onClick={onNewChat}>
        Sidebar new chat
      </button>
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

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mockAcpCreateSession(...args),
  discoverAcpProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: async ({ parts }: { parts: string[] }) => ({
    path: parts.join("/") || "/tmp",
  }),
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
    onExitSearch,
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
      {activeView === "search" ? (
        <button type="button" onClick={onExitSearch}>
          Exit search
        </button>
      ) : null}
    </section>
  )) satisfies typeof AppShellContentType,
}));

describe("AppShell global navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    mockAcpCreateSession.mockReset();
    mockAcpCreateSession.mockResolvedValue({ sessionId: "created-session" });
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      draftsBySession: {},
      queuedMessageBySession: {},
      scrollTargetMessageBySession: {},
      activeSessionId: null,
      isConnected: true,
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: false,
      isContextPanelOpen: false,
      activeWorkspaceBySession: {},
      modelSelectionIntentBySession: {},
    });
    useAgentStore.setState({
      selectedProvider: "goose",
    });
    useProjectStore.setState({
      projects: [],
      loading: false,
      activeProjectId: null,
    });
  });

  it("starts a full blank chat from the sidebar new chat action", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith("goose", "~", {
      modelId: undefined,
      personaId: undefined,
      projectId: undefined,
    });
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

  it("opens search from the top bar and returns to the previous view", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("search");

    await user.click(screen.getByRole("button", { name: "Exit search" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    });
  });

  it("opens search with Cmd+K", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.keyboard("{Meta>}k{/Meta}");

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("search");
    });
  });
});
