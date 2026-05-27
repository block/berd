import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { AppShell } from "./AppShell";

const mocks = vi.hoisted(() => ({
  startupRetry: vi.fn(),
  defaultModelRepair: vi.fn(),
  startupState: {
    ready: true,
    error: null as unknown,
  },
  migrationState: {
    status: "ready",
    error: null as Error | null,
  },
}));

vi.mock("@tauri-apps/api/path", () => ({
  appLogDir: vi.fn().mockResolvedValue("/Users/test/Library/Logs/goose"),
}));

vi.mock("./hooks/useAppStartup", () => ({
  useAppStartup: () => ({
    ready: mocks.startupState.ready,
    error: mocks.startupState.error,
    retry: mocks.startupRetry,
  }),
}));

vi.mock("@/features/agents/hooks/useAgentBuilderCoordinator", () => ({
  useAgentBuilderCoordinator: () => ({
    closeAgentBuilderSession: vi.fn(),
    navigateAgentBuilderAgents: vi.fn(),
    navigateAgentBuilderChat: vi.fn(),
  }),
}));

vi.mock("@/features/migration/hooks/useMigrationGate", () => ({
  useMigrationGate: () => ({
    status: mocks.migrationState.status,
    error: mocks.migrationState.error ?? undefined,
    retry: vi.fn(),
  }),
}));

vi.mock("@/features/migration/hooks/useDefaultModelGate", () => ({
  useDefaultModelGate: (...args: unknown[]) =>
    mocks.defaultModelRepair(...args),
}));

vi.mock("@/features/projects/api/projects", () => ({
  archiveProject: vi.fn().mockResolvedValue(undefined),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  listProjects: vi.fn().mockResolvedValue([]),
  reorderProjects: vi.fn().mockResolvedValue(undefined),
  updateProject: vi.fn(),
}));

vi.mock("@/features/updates/ui/UpdateButton", () => ({
  UpdateButton: () => null,
}));

vi.mock("./ui/AppShellContent", () => ({
  AppShellContent: () => <section data-testid="app-shell-content" />,
}));

describe("AppShell startup diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    mocks.startupState.ready = true;
    mocks.startupState.error = null;
    mocks.migrationState.status = "ready";
    mocks.migrationState.error = null;
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

  it("renders app content even when migration setup fails", () => {
    mocks.migrationState.status = "error";
    mocks.migrationState.error = new Error("default save failed");

    render(<AppShell />);

    expect(screen.getByTestId("app-shell-content")).toBeInTheDocument();
    expect(mocks.defaultModelRepair).toHaveBeenCalledWith(true);
    expect(
      screen.queryByRole("heading", { name: "Goose couldn't start" }),
    ).not.toBeInTheDocument();
  });

  it("shows diagnostics only for app startup errors", async () => {
    const user = userEvent.setup();
    mocks.startupState.error = new Error(
      "Failed to spawn goose serve (binary: goosed): denied",
    );

    render(<AppShell />);

    expect(
      screen.getByRole("heading", { name: "Goose couldn't start" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell-content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.startupRetry).toHaveBeenCalledTimes(1);
  });
});
