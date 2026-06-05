import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { PANE_JUMP_NAVIGATION_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  setExperimentConfigValue,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  EXPERIMENT_PREFERENCES_STORAGE_VERSION,
} from "@/features/experiments/experimentPreferences";
import { AppShell } from "./AppShell";
import type { AppShellContent as AppShellContentType } from "./ui/AppShellContent";

const mockAcpCreateSession = vi.hoisted(() => vi.fn());
const mockCreatePersonaSource = vi.hoisted(() => vi.fn());
const mockListPersonaSources = vi.hoisted(() => vi.fn());
const mockReadAgentSourceFile = vi.hoisted(() => vi.fn());
const mockDeletePersonaSource = vi.hoisted(() => vi.fn());
const mockAutomationBuilderSave = vi.hoisted(() => vi.fn());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function rect(left = 0, top = 0, width = 100, height = 100): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockVisibleRegionRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect(),
  );
}

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
      <button type="button" onClick={() => onNavigate?.("builderbot")}>
        Sidebar builderbot
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

vi.mock("@/shared/api/agents", () => ({
  createPersonaSource: (...args: unknown[]) => mockCreatePersonaSource(...args),
  listPersonaSources: (...args: unknown[]) => mockListPersonaSources(...args),
  readAgentSourceFile: (...args: unknown[]) => mockReadAgentSourceFile(...args),
  deletePersonaSource: (...args: unknown[]) => mockDeletePersonaSource(...args),
  promotePersonaSource: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: async ({ parts }: { parts: string[] }) => ({
    path: parts.join("/") || "/tmp",
  }),
}));

vi.mock("@/features/updates/ui/UpdateButton", () => ({
  UpdateButton: () => null,
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose"]),
    agentReadiness: new Map([["goose", "ready"]]),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./ui/AppShellContent", () => ({
  AppShellContent: (({
    activeView,
    activeSettingsSection,
    activeSkillsSkillId,
    activeAgentsPersonaId,
    activeAutomationsRoute,
    activeBuilderbotRoute,
    onNavigateSkills,
    onNavigateAgents,
    onNavigateAutomations,
    onNavigateBuilderbot,
    onSkillsBreadcrumbLabelChange,
    onAgentsBreadcrumbLabelChange,
    onAutomationsBreadcrumbLabelChange,
    onBuilderbotBreadcrumbLabelChange,
    onAutomationBuilderLeaveActionChange,
    onCreatePersona,
    onExitSearch,
    onOpenAgent,
  }) => (
    <section>
      <div data-testid="active-view">{activeView}</div>
      <div data-testid="settings-section">{activeSettingsSection}</div>
      <div data-testid="skill-route">{activeSkillsSkillId ?? "list"}</div>
      <div data-testid="agent-route">{activeAgentsPersonaId ?? "list"}</div>
      <div data-testid="automation-route">
        {JSON.stringify(activeAutomationsRoute)}
      </div>
      <div data-testid="builderbot-route">
        {JSON.stringify(activeBuilderbotRoute)}
      </div>
      <button
        type="button"
        onClick={() => {
          onSkillsBreadcrumbLabelChange?.("Code Review");
          onNavigateSkills("skill-1");
        }}
      >
        Open skill detail
      </button>
      <button
        type="button"
        onClick={() => {
          onAgentsBreadcrumbLabelChange?.("Reviewer");
          onNavigateAgents("persona-1");
        }}
      >
        Open agent detail
      </button>
      <button
        type="button"
        onClick={() => {
          onAutomationsBreadcrumbLabelChange?.("History");
          onNavigateAutomations({ surface: "history", selectedRun: null });
        }}
      >
        Open automation history
      </button>
      <button
        type="button"
        onClick={() => {
          onAutomationsBreadcrumbLabelChange?.("Add automation");
          onNavigateAutomations({
            surface: "builder",
            automationId: "automation-1",
          });
        }}
      >
        Open automation builder
      </button>
      <button
        type="button"
        onClick={() => {
          onBuilderbotBreadcrumbLabelChange?.("TASK-1");
          onNavigateBuilderbot({ surface: "task", taskKey: "TASK-1" });
        }}
      >
        Open builderbot task
      </button>
      {activeView === "automations" &&
      activeAutomationsRoute.surface === "builder" ? (
        <button
          type="button"
          onClick={() =>
            onAutomationBuilderLeaveActionChange?.({
              hasUnsavedChanges: true,
              save: async () => {
                mockAutomationBuilderSave();
                return true;
              },
              discard: () => {},
            })
          }
        >
          Mark automation edits unsaved
        </button>
      ) : null}
      <button type="button" onClick={() => onOpenAgent?.("persona-resolves")}>
        Start chat with resolving agent
      </button>
      <button type="button" onClick={() => onOpenAgent?.("persona-unresolved")}>
        Start chat with unresolved agent
      </button>
      {activeView === "agents" ? (
        <button type="button" onClick={onCreatePersona}>
          Create agent
        </button>
      ) : null}
      {activeView === "search" ? (
        <button type="button" onClick={onExitSearch}>
          Exit search
        </button>
      ) : null}
      <input aria-label="Mock search input" />
    </section>
  )) satisfies typeof AppShellContentType,
}));

describe("AppShell global navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-global-composer-visible");
    mockAcpCreateSession.mockReset();
    mockAcpCreateSession.mockResolvedValue({ sessionId: "created-session" });
    mockCreatePersonaSource.mockReset();
    mockCreatePersonaSource.mockResolvedValue({
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Untitled agent created-sess",
      description: "Draft",
      content: "Draft in progress.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    });
    mockListPersonaSources.mockReset();
    mockListPersonaSources.mockResolvedValue([]);
    mockReadAgentSourceFile.mockReset();
    mockReadAgentSourceFile.mockRejectedValue(new Error("not found"));
    mockDeletePersonaSource.mockReset();
    mockDeletePersonaSource.mockResolvedValue(undefined);
    mockAutomationBuilderSave.mockReset();
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
    const { container } = render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "goose",
      "~/goose artifacts",
      {
        modelId: undefined,
        projectId: undefined,
      },
    );
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--project-tint",
      ),
    ).toBe("transparent");
  });

  it("opens pane jump mode and focuses app regions by badge key", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.tagName === "HEADER") {
          return rect(0, 0, 1000, 48);
        }
        if (this.tagName === "MAIN") {
          return rect(260, 48, 740, 652);
        }
        if (this.querySelector('nav[aria-label="mock sidebar"]')) {
          return rect(0, 48, 260, 652);
        }
        return rect(760, 580, 220, 100);
      },
    );
    render(<AppShell />);

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();
    expect(screen.getByText("s")).toBeInTheDocument();
    expect(screen.getByText("sidebar")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "s" });
    expect(
      screen.getByRole("button", { name: "Sidebar new chat" }),
    ).toHaveFocus();

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByPlaceholderText("Start a conversation")).toHaveFocus();
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
  });

  it("starts pane jump mode from the main composer", () => {
    mockVisibleRegionRects();
    render(<AppShell />);

    screen.getByPlaceholderText("Start a conversation").focus();
    fireEvent.keyDown(screen.getByPlaceholderText("Start a conversation"), {
      key: ";",
      ctrlKey: true,
    });

    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();
  });

  it("starts pane jump mode from the configured experiment shortcut", () => {
    setExperimentConfigValue(
      PANE_JUMP_NAVIGATION_EXPERIMENT_ID,
      "shortcut",
      "Ctrl+.",
    );
    mockVisibleRegionRects();
    render(<AppShell />);

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: ".", ctrlKey: true });
    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();
  });

  it("does not start pane jump mode when the experiment is disabled", () => {
    setExperimentEnabled(PANE_JUMP_NAVIGATION_EXPERIMENT_ID, false);
    mockVisibleRegionRects();
    render(<AppShell />);

    screen.getByPlaceholderText("Start a conversation").focus();
    fireEvent.keyDown(screen.getByPlaceholderText("Start a conversation"), {
      key: ";",
      ctrlKey: true,
    });

    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
  });

  it("starts a full blank chat from the saved artifact location", async () => {
    window.localStorage.setItem(
      "goose:artifact-root-path",
      "/Users/test/goose artifacts test",
    );
    const user = userEvent.setup();

    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "goose",
      "/Users/test/goose artifacts test",
      {
        modelId: undefined,
        projectId: undefined,
      },
    );
    expect(
      useChatSessionStore
        .getState()
        .getSession(useChatSessionStore.getState().activeSessionId ?? ""),
    ).toMatchObject({
      workingDir: "/Users/test/goose artifacts test",
    });
  });

  it("reserves toast space only while the global composer is visible", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute(
        "data-global-composer-visible",
        "true",
      );
    });

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(document.documentElement).not.toHaveAttribute(
      "data-global-composer-visible",
    );
  });

  it("returns home and focuses the global composer with Cmd+N from chat", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });
    mockAcpCreateSession.mockClear();

    await user.keyboard("{Meta>}n{/Meta}");

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    });
    const textbox = await screen.findByPlaceholderText("Start a conversation");
    await waitFor(() => {
      expect(textbox).toHaveFocus();
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("drops pending Cmd+N focus when the global composer remains hidden", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AppShell>
        <div>Custom shell content</div>
      </AppShell>,
    );

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByPlaceholderText("Start a conversation"),
    ).not.toBeInTheDocument();

    await user.keyboard("{Meta>}n{/Meta}");

    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBeNull();
    });
    rerender(<AppShell />);

    const textbox = await screen.findByPlaceholderText("Start a conversation");
    expect(textbox).not.toHaveFocus();
  });

  it("opens a blank chat before ACP session creation finishes", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalled();
    });

    const draftSessionId = useChatSessionStore.getState().activeSessionId;
    expect(draftSessionId).toEqual(expect.any(String));
    expect(draftSessionId).not.toBe("created-session");
    expect(
      useChatSessionStore.getState().getSession(draftSessionId ?? ""),
    ).toMatchObject({
      creationState: "pending",
      workingDir: "~/goose artifacts",
    });
    const draftWorkingDir = useChatSessionStore
      .getState()
      .getSession(draftSessionId ?? "")?.workingDir;

    act(() => {
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "created-session",
      );
    });
    expect(
      useChatSessionStore.getState().getSession("created-session"),
    ).toMatchObject({
      creationState: undefined,
      workingDir: draftWorkingDir,
    });
  });

  it("shows ACP error data when draft session creation fails", async () => {
    const error = new Error("Internal error") as Error & { data: string };
    error.name = "RequestError";
    error.data = "Failed to create session: provider config is missing";
    mockAcpCreateSession.mockRejectedValueOnce(error);
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      const draftSessionId = useChatSessionStore.getState().activeSessionId;
      expect(
        useChatSessionStore.getState().getSession(draftSessionId ?? ""),
      ).toMatchObject({
        creationState: "failed",
        creationError: "Failed to create session: provider config is missing",
      });
    });

    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";
    const messages = useChatStore.getState().messagesBySession[draftSessionId];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: [
        {
          type: "systemNotification",
          notificationType: "error",
          text: "Failed to create session: provider config is missing",
        },
      ],
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

  it("goes back and forward through Builderbot detail subroutes", async () => {
    window.localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
        experiments: {
          [BUILDERBOT_SURFACE_EXPERIMENT_ID]: { enabled: true },
        },
      }),
    );
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar builderbot" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open builderbot task" }),
    );

    expect(screen.getByTestId("active-view")).toHaveTextContent("builderbot");
    expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
      '"surface":"task"',
    );
    expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
      '"taskKey":"TASK-1"',
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
        '"surface":"overview"',
      );
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
        '"surface":"task"',
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

  it("starts a new agent builder session without prompting against itself", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(
      screen.queryByText("Save this agent draft?"),
    ).not.toBeInTheDocument();
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "created-session",
      intent: "build-agent",
      targetAgentPath:
        "/Users/test/.agents/agents/untitled-agent-created-session.md",
    });
  });

  it("waits to show the new agent builder until the draft target is ready", async () => {
    const user = userEvent.setup();
    const draft = deferred<{
      type: "agent";
      path: string;
      name: string;
      description: string;
      content: string;
      global: boolean;
      writable: boolean;
      properties: { draft: boolean; builderSessionId: string };
    }>();
    mockCreatePersonaSource.mockReturnValueOnce(draft.promise);
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalled();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    expect(useChatSessionStore.getState().getActiveSession()).toBeNull();

    draft.resolve({
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Untitled agent created-sess",
      description: "Draft",
      content: "Draft in progress.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "created-session",
      intent: "build-agent",
      targetAgentPath:
        "/Users/test/.agents/agents/untitled-agent-created-session.md",
    });
  });

  it("prompts when navigating away from a dirty new agent draft", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));

    await waitFor(() => {
      expect(screen.getByText("Save this agent draft?")).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });

  it("does not prompt when navigating away from an untouched new agent draft", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(
      screen.queryByText("Save this agent draft?"),
    ).not.toBeInTheDocument();
    expect(mockDeletePersonaSource).not.toHaveBeenCalled();
  });

  it("returns to agent builder mode after going back then forward", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "created-session",
      intent: "build-agent",
    });

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "created-session",
      intent: "build-agent",
      targetAgentPath:
        "/Users/test/.agents/agents/untitled-agent-created-session.md",
    });
  });

  it("prompts when navigating away after typing in the agent builder chat", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    useChatStore.getState().setDraft("created-session", "make me a reviewer");

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));

    await waitFor(() => {
      expect(screen.getByText("Save this agent draft?")).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });

  it("returns from provider setup settings to the dirty agent draft without prompting", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_SETTINGS_EVENT, {
          detail: {
            section: "providers",
            returnTarget: {
              type: "agent-builder-provider-setup",
              sessionId: "created-session",
              providerId: "claude-acp",
            },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(
      screen.queryByText("Save this agent draft?"),
    ).not.toBeInTheDocument();
  });

  it("discarding a dirty agent draft continues the pending navigation", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(mockDeletePersonaSource).toHaveBeenCalledWith(dirtyDraft.path);
  });

  it("keeping a dirty agent draft continues the pending navigation without deleting it", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(await screen.findByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(mockDeletePersonaSource).not.toHaveBeenCalled();
  });

  it("prompts before leaving unsaved automation builder changes", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(
      screen.queryByText("Unsaved automation changes"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
  });

  it("discarding unsaved automation builder changes continues navigation", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
  });

  it("saving unsaved automation builder changes continues navigation", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(
      await screen.findByRole("button", { name: "Save changes" }),
    );

    expect(mockAutomationBuilderSave).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
  });

  it("prompts before leaving unsaved automation builder changes with keyboard navigation", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.keyboard("{Meta>}n{/Meta}");

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
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

  it("shows the page title as the top bar header on subpages", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");

    expect(
      screen.queryByRole("link", { name: "goose" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Home" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("shows and navigates from third-level Skills breadcrumbs", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    expect(screen.getByRole("link", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Code Review" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("link", { name: "Skills" }));

    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("list");
    });
  });

  it("shows Automations history as a third-level breadcrumb", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation history" }),
    );

    expect(
      screen.getByRole("link", { name: "Automations" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows Chat / project / session title for a chat inside a project", async () => {
    const user = userEvent.setup();
    const { container } = render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const project: ProjectInfo = {
      id: "proj-1",
      path: "/tmp/sample-project",
      name: "Sample Project",
      description: "",
      prompt: "",
      icon: "folder",
      color: "blue",
      preferredProvider: null,
      preferredModel: null,
      workingDirs: [],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
    };
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: "created-session",
      title: "MCPs vs Extensions",
      projectId: "proj-1",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };

    act(() => {
      useProjectStore.setState({ projects: [project] });
      useChatSessionStore.setState({
        sessions: [session],
        activeSessionId: "created-session",
        hasHydratedSessions: true,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Chat")).toBeInTheDocument();
      expect(screen.getByText("Sample Project")).toBeInTheDocument();
      expect(screen.getByText("MCPs vs Extensions")).toBeInTheDocument();
    });
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--project-tint",
      ),
    ).toBe("var(--color-pill-blue)");
  });

  it("forwards a persona's provider and model when the provider resolves", async () => {
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [{ id: "goose", label: "Goose" }],
      personas: [
        {
          id: "persona-resolves",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "goose",
          model: "goose-model",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Start chat with resolving agent" }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "goose",
        "~/goose artifacts",
        {
          modelId: "goose-model",
          projectId: undefined,
        },
      );
    });
  });

  it("does not forward a persona's model when its provider does not resolve", async () => {
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [{ id: "goose", label: "Goose" }],
      personas: [
        {
          id: "persona-unresolved",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "totally-unknown-provider",
          model: "unresolved-model",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Start chat with unresolved agent" }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "goose",
        "~/goose artifacts",
        {
          modelId: undefined,
          projectId: undefined,
        },
      );
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
