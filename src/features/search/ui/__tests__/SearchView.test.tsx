import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render as renderWithoutQueryClient,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { sessionSearchStamp } from "@/shared/api/sessionSearch";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { SearchView } from "../SearchView";

const mockListSkills = vi.hoisted(() => vi.fn());
const mockListExtensions = vi.hoisted(() => vi.fn());
const mockGetAutomationTiles = vi.hoisted(() => vi.fn());
const mockAcpSearchSessions = vi.hoisted(() => vi.fn());

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: (...args: unknown[]) => mockListExtensions(...args),
}));

vi.mock("@/shared/api/acp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/acp")>()),
  acpSearchSessions: (...args: unknown[]) => mockAcpSearchSessions(...args),
}));

// With a QueryClient in the tree (see `render` below), useSkillSearch fetches
// through skillsQuery's per-leg queries instead of the provider-less
// `listSkills` fallback, so both discovery legs need stubs too.
vi.mock("@/features/skills/api/skills", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  listGooseSourceSkills: (...args: unknown[]) => mockListSkills(...args),
  listBerdAppSkills: () => Promise.resolve([]),
}));

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: (...args: unknown[]) => mockGetAutomationTiles(...args),
}));

// useAutomationSearch reads the shared automation tile list through
// react-query, so every render needs a QueryClient — a fresh one per render
// keeps the tile cache from bleeding between tests.
function render(ui: ReactElement) {
  return renderWithoutQueryClient(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

function matchedInfo(sessionId: string) {
  return {
    sessionId,
    title: "Server match",
    updatedAt: "2026-04-12T12:00:00Z",
    createdAt: "2026-04-12T12:00:00Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 3,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
  };
}

describe("SearchView", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AUTOMATIONS", "1");
    mockListExtensions.mockReset();
    mockListExtensions.mockResolvedValue([]);
    mockGetAutomationTiles.mockReset();
    mockGetAutomationTiles.mockResolvedValue({ tiles: [] });
    mockAcpSearchSessions.mockReset();
    // Production shape: the server matches every target handed to it here, and
    // searchedIds ⊆ matchedInfos (only matched targets are export-enriched).
    mockAcpSearchSessions.mockImplementation(
      async (_query: string, targets: { id: string }[]) => ({
        results: [],
        searchedIds: targets.map((target) => target.id),
        failedIds: [],
        matchedInfos: targets.map((target) => matchedInfo(target.id)),
      }),
    );
    mockListSkills.mockReset();
    mockListSkills.mockResolvedValue([
      {
        name: "reporting",
        description: "Create crisp progress reports",
        sourceLabel: "Global",
        projectLinks: [],
      },
    ]);
    useAgentStore.setState({
      personas: [
        {
          id: "agent-reviewer",
          displayName: "Reviewer",
          systemPrompt: "Review code changes",
          isBuiltin: true,
          writable: false,
        },
        {
          id: "agent-writer",
          displayName: "Writer",
          systemPrompt: "Write release notes",
          isBuiltin: true,
          writable: false,
        },
      ],
    });
    useChatSessionStore.setState({ sessions: [] });
    useChatStore.setState({ messagesBySession: {} });
    useProjectStore.setState({ projects: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Profile capabilities resolve from this store, so a test that disables a
    // feature toggle has to hand the next one an unloaded store back.
    useRuntimeConfigStore.setState({
      loaded: false,
      config: DEFAULT_RUNTIME_CONFIG,
    });
  });

  it("does not render stale or duplicate extension results", async () => {
    mockListExtensions.mockResolvedValue([
      {
        config_key: "glean-platform",
        type: "platform",
        name: "glean-platform",
        display_name: "Glean",
        description: "Search and read internal documents with Glean",
        enabled: false,
      },
      {
        config_key: "glean-stdio",
        type: "stdio",
        name: "Glean\u200b",
        description: "Search and read internal documents with Glean",
        cmd: "glean",
        args: [],
        enabled: false,
      },
    ]);

    const user = userEvent.setup();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "glean");
    expect(
      await screen.findAllByRole("button", { name: /Open extension/i }),
    ).toHaveLength(1);

    await user.clear(input);
    await user.type(input, "experiment");
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open extension Glean/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("derives both dialog scroll masks from the popover surface", async () => {
    // The dialog paints bg-popover, which no longer matches background/card
    // in dark mode; a fade ending anywhere else reads as a lighter band.
    mockListExtensions.mockResolvedValue([
      {
        config_key: "glean-stdio",
        type: "stdio",
        name: "Glean",
        description: "Search and read internal documents with Glean",
        cmd: "glean",
        args: [],
        enabled: false,
      },
    ]);

    const user = userEvent.setup();
    const { container } = render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "glean");
    await screen.findAllByRole("button", { name: /Open extension/i });

    expect(
      container.querySelector('[class*="after:from-popover"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[class*="to-popover"]'),
    ).toBeInTheDocument();
    expect(container.querySelector('[class*="to-background"]')).toBeNull();
  });

  it("keeps punctuation-distinct and symbol-only extensions reachable", async () => {
    mockListExtensions.mockResolvedValue([
      {
        config_key: "payments-plus",
        type: "stdio",
        name: "Payments+",
        cmd: "payments-plus",
        args: [],
        enabled: false,
      },
      {
        config_key: "payments-plain",
        type: "stdio",
        name: "Payments",
        cmd: "payments",
        args: [],
        enabled: false,
      },
      {
        config_key: "symbols-star",
        type: "stdio",
        name: "★",
        cmd: "star",
        args: [],
        enabled: false,
      },
      {
        config_key: "symbols-heart",
        type: "stdio",
        name: "♥",
        cmd: "heart",
        args: [],
        enabled: false,
      },
    ]);

    const user = userEvent.setup();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "payments");
    expect(
      await screen.findAllByRole("button", {
        name: /Open extension Payments/i,
      }),
    ).toHaveLength(2);

    await user.clear(input);
    await user.type(input, "★");
    expect(
      await screen.findByRole("button", { name: "Open extension ★" }),
    ).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "♥");
    expect(
      await screen.findByRole("button", { name: "Open extension ♥" }),
    ).toBeInTheDocument();
  });

  it("does not count settings results when the caller cannot open settings", async () => {
    mockListSkills.mockResolvedValue([]);
    useAgentStore.setState({ personas: [] });
    const user = userEvent.setup();
    render(
      <SearchView
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "animated avatars");

    expect(
      await screen.findByText('No matches for "animated avatars"'),
    ).toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("uses localized copy for settings results", async () => {
    const user = userEvent.setup();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "animated avatars");

    expect(
      await screen.findByRole("button", {
        name: "Open Animated avatars settings",
      }),
    ).toHaveTextContent("Settings > Animated avatars");
    expect(
      screen.getByRole("tab", { name: "Settings (1)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /Settings navigation/ }),
    ).not.toBeInTheDocument();
  });

  it("finds the telemetry toggle while the telemetry capability is available", async () => {
    const user = userEvent.setup();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "usage data");

    expect(
      await screen.findByRole("button", {
        name: "Open Share usage data settings",
      }),
    ).toHaveTextContent("Settings > Share usage data");
  });

  // The row itself is hidden without the capability (TelemetryConsentRow), so
  // the search hit has to go with it — otherwise the result navigates to a
  // System page that renders no such control.
  it("hides the telemetry toggle when runtime config disables telemetry", async () => {
    useRuntimeConfigStore.setState({
      loaded: true,
      config: {
        ...DEFAULT_RUNTIME_CONFIG,
        featureToggles: { telemetry: false },
      },
    });
    mockListSkills.mockResolvedValue([]);
    useAgentStore.setState({ personas: [] });
    const user = userEvent.setup();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "usage data");

    expect(
      await screen.findByText('No matches for "usage data"'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Share usage data settings" }),
    ).not.toBeInTheDocument();
  });

  it("excludes automations without IDs from results and counts", async () => {
    mockListSkills.mockResolvedValue([]);
    useAgentStore.setState({ personas: [] });
    mockGetAutomationTiles.mockResolvedValue({
      tiles: [
        {
          title: "Weekly planning",
          instructions: ["Prepare the planning brief"],
        },
        {
          id: "automation-weekly-planning",
          title: "Weekly planning",
          schedule: "hidden midnight schedule",
          instructions: ["Prepare the planning brief"],
        },
      ],
    });

    const user = userEvent.setup();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "weekly planning");

    expect(
      await screen.findByRole("tab", { name: "Automations (1)" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Open automation/i }),
    ).toHaveLength(1);

    await user.clear(input);
    await user.type(input, "hidden midnight schedule");
    expect(
      await screen.findByText('No matches for "hidden midnight schedule"'),
    ).toBeInTheDocument();
  });

  it("sweeps chat search once per query and re-sweeps only on membership or stamp changes", async () => {
    const baseSession = {
      id: "session-1",
      title: "Needle notes",
      createdAt: "2026-04-10T12:00:00Z",
      updatedAt: "2026-04-10T12:00:00Z",
      messageCount: 1,
    };
    const otherSession = {
      id: "session-2",
      title: "Second needle",
      createdAt: "2026-04-09T12:00:00Z",
      updatedAt: "2026-04-09T12:00:00Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({ sessions: [baseSession, otherSession] });

    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    fireEvent.change(input, { target: { value: "needle" } });

    await waitFor(() => {
      expect(mockAcpSearchSessions).toHaveBeenCalledTimes(1);
    });
    // Let the render/effect chain settle: an unstable search callback used to
    // re-fire a second, discarded sweep from the query state update.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(1);

    // Same membership and stamps, new session objects (subtitle stream, unread
    // flip, meta-only `session_info_update`): no re-sweep.
    const subtitledSession = { ...baseSession, subtitle: "streaming snippet" };
    act(() => {
      useChatSessionStore.setState({
        sessions: [subtitledSession, { ...otherSession }],
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(1);

    // Same membership and stamps, reordered: every session-list merge re-sorts
    // by activity, so a background session bubbling up must not count as a
    // membership change.
    act(() => {
      useChatSessionStore.setState({
        sessions: [{ ...otherSession }, subtitledSession],
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(1);

    // Persona refresh (60s timer / window focus) replaces the store array with
    // fresh objects, changing the resolvers the search hook was handed: still
    // no re-sweep.
    act(() => {
      useAgentStore.setState({
        personas: useAgentStore
          .getState()
          .personas.map((persona) => ({ ...persona })),
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(1);

    // New content in a session already on screen (the periodic list refresh
    // picking up a backend change): one re-sweep, carrying the new stamp so the
    // changed session re-exports while the other one stays a cache hit.
    const bumpedSession = {
      ...subtitledSession,
      updatedAt: "2026-04-10T13:00:00Z",
      messageCount: 3,
    };
    act(() => {
      useChatSessionStore.setState({
        sessions: [bumpedSession, { ...otherSession }],
      });
    });
    await waitFor(() => {
      expect(mockAcpSearchSessions).toHaveBeenCalledTimes(2);
    });
    expect(mockAcpSearchSessions).toHaveBeenLastCalledWith(
      "needle",
      expect.arrayContaining([
        {
          id: "session-1",
          stamp: sessionSearchStamp(bumpedSession),
        },
      ]),
      expect.anything(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(2);

    // Membership change: full re-sweep (unchanged sessions are corpus-cache
    // hits inside searchSessionsViaExports).
    act(() => {
      useChatSessionStore.setState({
        sessions: [
          bumpedSession,
          otherSession,
          {
            id: "session-3",
            title: "Third needle",
            createdAt: "2026-04-12T12:00:00Z",
            updatedAt: "2026-04-12T12:00:00Z",
            messageCount: 1,
          },
        ],
      });
    });
    await waitFor(() => {
      expect(mockAcpSearchSessions).toHaveBeenCalledTimes(3);
    });
    expect(mockAcpSearchSessions).toHaveBeenLastCalledWith(
      "needle",
      [
        expect.objectContaining({ id: "session-1" }),
        expect.objectContaining({ id: "session-2" }),
        expect.objectContaining({ id: "session-3" }),
      ],
      expect.anything(),
    );
  });

  it("keeps a content-only chat result rendered across a membership change", async () => {
    // Matches "needle" only inside its messages, so it survives a re-sweep
    // only if the results are not rebuilt from metadata alone.
    const contentSession = {
      id: "session-1",
      title: "Wandering thoughts",
      createdAt: "2026-04-10T12:00:00Z",
      updatedAt: "2026-04-10T12:00:00Z",
      messageCount: 1,
    };
    const messageMatch = {
      sessionId: "session-1",
      snippet: "needle in message",
      messageId: "message-1",
      matchCount: 1,
    };
    useChatSessionStore.setState({ sessions: [contentSession] });
    mockAcpSearchSessions.mockImplementation(
      async (_query: string, targets: { id: string }[]) => ({
        results: [messageMatch],
        searchedIds: targets.map((target) => target.id),
        failedIds: [],
        matchedInfos: targets.map((target) => matchedInfo(target.id)),
      }),
    );

    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    fireEvent.change(input, { target: { value: "needle" } });

    // Once the debounced query has reached the sweep, the recents list is no
    // longer what is on screen, so the row can only come from the sweep's
    // message match.
    await waitFor(() => {
      expect(mockAcpSearchSessions).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Wandering thoughts/ }),
      ).toBeVisible();
    });

    // A session joining the list re-sweeps the same query. The row must not
    // blink out while the sweep is in flight.
    type Sweep = {
      results: (typeof messageMatch)[];
      searchedIds: string[];
      failedIds: string[];
      matchedInfos: ReturnType<typeof matchedInfo>[];
    };
    let resolveSweep: (sweep: Sweep) => void = () => {};
    mockAcpSearchSessions.mockReturnValueOnce(
      new Promise<Sweep>((resolve) => {
        resolveSweep = resolve;
      }),
    );
    act(() => {
      useChatSessionStore.setState({
        sessions: [
          contentSession,
          {
            id: "session-2",
            title: "Second chat",
            createdAt: "2026-04-11T12:00:00Z",
            updatedAt: "2026-04-11T12:00:00Z",
            messageCount: 1,
          },
        ],
      });
    });

    expect(
      screen.getByRole("button", { name: /Wandering thoughts/ }),
    ).toBeVisible();

    await act(async () => {
      resolveSweep({
        results: [messageMatch],
        searchedIds: ["session-1", "session-2"],
        failedIds: [],
        matchedInfos: [matchedInfo("session-1"), matchedInfo("session-2")],
      });
    });

    expect(
      screen.getByRole("button", { name: /Wandering thoughts/ }),
    ).toBeVisible();
  });

  it("clears the query before Escape exits search", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(
      <SearchView
        variant="dialog"
        onExit={onExit}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "reviewer");
    const reviewer = await screen.findByRole("button", {
      name: "Start chat with Reviewer",
    });
    fireEvent.focus(reviewer);
    fireEvent.keyDown(reviewer, { key: "Escape" });

    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(onExit).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("limits keyboard navigation to the selected result category", async () => {
    const user = userEvent.setup();
    const onOpenAgent = vi.fn();
    const onOpenSkill = vi.fn();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={onOpenAgent}
        onOpenAutomation={vi.fn()}
        onOpenSkill={onOpenSkill}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "r");
    const reviewer = await screen.findByRole("button", {
      name: "Start chat with Reviewer",
    });
    await screen.findByRole("button", {
      name: "Start chat with reporting",
    });

    await user.click(screen.getByRole("tab", { name: /Skills \(1\)/i }));
    expect(reviewer).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start chat with reporting" }),
    ).toBeVisible();

    await user.click(input);
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onOpenSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "reporting" }),
    );
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("navigates command-k results with arrow keys and selects the active result", async () => {
    const user = userEvent.setup();
    const onOpenAgent = vi.fn();
    const onOpenSkill = vi.fn();
    render(
      <SearchView
        onExit={vi.fn()}
        onSelectSearchResult={vi.fn()}
        onOpenExtension={vi.fn()}
        onOpenAgent={onOpenAgent}
        onOpenAutomation={vi.fn()}
        onOpenSkill={onOpenSkill}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(input, "r");

    const reviewer = await screen.findByRole("button", {
      name: "Start chat with Reviewer",
    });
    const writer = await screen.findByRole("button", {
      name: "Start chat with Writer",
    });
    const reporting = await screen.findByRole("button", {
      name: "Start chat with reporting",
    });

    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(reviewer).toHaveAttribute("data-active", "true");
    });
    expect(input).toHaveAttribute("aria-activedescendant", reviewer.id);
    expect(document.activeElement).toBe(input);

    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(writer).toHaveAttribute("data-active", "true");
    });

    await user.keyboard("{ArrowUp}");
    await waitFor(() => {
      expect(reviewer).toHaveAttribute("data-active", "true");
    });

    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(reporting).toHaveAttribute("data-active", "true");
    });

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => {
      expect(reviewer).toHaveAttribute("data-active", "true");
    });

    await user.keyboard("{ArrowRight}");
    await user.keyboard("{Enter}");

    expect(onOpenSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "reporting" }),
    );
    expect(onOpenAgent).not.toHaveBeenCalled();
  });
});
