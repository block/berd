import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  dispatchOnboarding,
  resetOnboarding,
} from "@/features/onboarding/model";
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

vi.mock("@/features/projects/artifact/prefetchProjectArtifactRenderer", () => ({
  prefetchProjectArtifactRenderer: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/features/updates/ui/UpdateButton", () => ({
  UpdateButton: () => null,
}));

vi.mock("@/features/updates/ui/ChannelSwitchDialog", () => ({
  ChannelSwitchDialog: () => null,
}));

vi.mock("@/features/updates/ui/BetaBadge", () => ({
  BetaBadge: () => null,
}));

vi.mock("@/shared/ui/GlobalComposerPill", () => ({
  GlobalComposerPill: () => null,
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
  AppShellContent: () => <section data-testid="app-shell-content" />,
}));

// The flow's own tests cover the landing ceremony; here only gate order matters.
vi.mock("@/features/onboarding/ui/OnboardingFlow", () => ({
  OnboardingFlow: () => <div data-testid="onboarding-flow" />,
}));

function renderAppShell() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>,
  );
}

describe("AppShell startup diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    dispatchOnboarding({ type: "complete" });
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
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useAgentStore.setState({
      selectedProvider: "goose",
    });
    useProjectStore.setState({
      projects: [],
      loading: false,
      hasFetchedProjects: true,
      activeProjectId: null,
      fetchProjects: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("renders app content even when migration setup fails", () => {
    mocks.migrationState.status = "error";
    mocks.migrationState.error = new Error("default save failed");

    renderAppShell();

    expect(screen.getByTestId("app-shell-content")).toBeInTheDocument();
    expect(mocks.defaultModelRepair).toHaveBeenCalledWith(true);
    expect(
      screen.queryByRole("heading", { name: "Berd couldn't start" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Berd loader while app startup is loading", () => {
    mocks.startupState.ready = false;

    const { container } = renderAppShell();

    expect(
      screen.getByRole("status", { name: "Starting Berd" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="berd-loader"]'),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByTestId("app-shell-content")).not.toBeInTheDocument();
  });

  it("shows diagnostics only for app startup errors", async () => {
    const user = userEvent.setup();
    mocks.startupState.error = new Error(
      "Failed to spawn goose serve (binary: goosed): denied",
    );

    renderAppShell();

    expect(
      screen.getByRole("heading", { name: "Berd couldn't start" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell-content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.startupRetry).toHaveBeenCalledTimes(1);
  });

  // First-run onboarding renders ahead of the startup gates: the welcome page
  // is where a fresh install answers telemetry consent, and it needs nothing
  // from the `goosed` sidecar.
  it.each([
    [
      "startup has not settled",
      () => {
        mocks.startupState.ready = false;
      },
    ],
    [
      "startup failed",
      () => {
        mocks.startupState.error = new Error(
          "Failed to spawn goose serve (binary: goosed): denied",
        );
      },
    ],
  ])("renders onboarding while %s", (_case, arrange) => {
    arrange();
    resetOnboarding();

    renderAppShell();

    expect(screen.getByTestId("onboarding-flow")).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Starting Berd" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Berd couldn't start" }),
    ).not.toBeInTheDocument();
  });

  it("falls through to the startup gates once onboarding completes", () => {
    mocks.startupState.error = new Error(
      "Failed to spawn goose serve (binary: goosed): denied",
    );
    resetOnboarding();
    renderAppShell();
    expect(screen.getByTestId("onboarding-flow")).toBeInTheDocument();

    act(() => {
      dispatchOnboarding({ type: "complete" });
    });

    expect(
      screen.getByRole("heading", { name: "Berd couldn't start" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-flow")).not.toBeInTheDocument();
  });

  it("shows a blocking configuration unavailable startup error", () => {
    mocks.startupState.error = Object.assign(
      new Error(
        "Runtime config unavailable: missing from fakeEndpoint: No fake response",
      ),
      { name: "RuntimeConfigUnavailableError" },
    );

    render(<AppShell />);

    expect(
      screen.getByRole("heading", { name: "Configuration unavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell-content")).not.toBeInTheDocument();
  });
});
