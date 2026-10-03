import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
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
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { SearchView } from "../SearchView";

const mockListSkills = vi.hoisted(() => vi.fn());
const mockListExtensions = vi.hoisted(() => vi.fn());
const mockGetAutomationTiles = vi.hoisted(() => vi.fn());
const mockMessageSearch = vi.hoisted(() => ({
  results: [] as import("@/shared/api/messageSearch").MessageSearchResult[],
  isLoading: false,
  error: null as string | null,
  status: "complete",
  hasMore: false,
  loadMore: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
}));
const mockUseMessageSearch = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useMessageSearch", () => ({
  useMessageSearch: (options: unknown) => {
    mockUseMessageSearch(options);
    return mockMessageSearch;
  },
}));

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: (...args: unknown[]) => mockListExtensions(...args),
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

describe("SearchView", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AUTOMATIONS", "1");
    mockListExtensions.mockReset();
    mockListExtensions.mockResolvedValue([]);
    mockGetAutomationTiles.mockReset();
    mockGetAutomationTiles.mockResolvedValue({ tiles: [] });
    Object.assign(mockMessageSearch, {
      results: [],
      isLoading: false,
      error: null,
      status: "complete",
      hasMore: false,
    });
    mockMessageSearch.loadMore.mockReset();
    mockMessageSearch.retry.mockReset();
    mockUseMessageSearch.mockReset();
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

  it("keeps title matches separate from each matching message and highlights literal OR keywords", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "title",
          title: "Needle notes",
          createdAt: "2026-04-10T12:00:00Z",
          updatedAt: "2026-04-10T12:00:00Z",
          messageCount: 2,
        },
      ],
    });
    mockMessageSearch.results = [0, 1].map((index) => ({
      sessionId: "unloaded",
      title: "Unloaded session",
      archivedAt: null,
      workingDir: "",
      updatedAt: "2026-04-10T12:00:00Z",
      messageCreatedAt: "2026-04-10T12:00:00Z",
      messageId: `message-${index}`,
      messageIndex: index,
      role: "user",
      snippet: "Needle matches needle or C++",
      matchCount: 3,
    }));
    const onSelect = vi.fn();
    render(
      <SearchView
        variant="dialog"
        onExit={vi.fn()}
        onSelectSearchResult={onSelect}
        onOpenExtension={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenAutomation={vi.fn()}
        onOpenSkill={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Universal search" });
    fireEvent.change(input, { target: { value: "needle C++" } });
    await screen.findByRole("tab", { name: "Messages (2)" });
    await userEvent.click(
      screen.getByRole("tab", { name: "Session Titles (0)" }),
    );
    expect(
      screen.queryByRole("button", { name: /Open message/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Messages (2)" }));
    const rows = screen.getAllByRole("button", { name: /Open message/ });
    expect(rows).toHaveLength(2);
    expect(
      Array.from(rows[0].querySelectorAll("mark")).map(
        (mark) => mark.textContent,
      ),
    ).toEqual(["Needle", "needle", "C++"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      "unloaded",
      "message-1",
      "needle C++",
      expect.objectContaining({ id: "unloaded" }),
    );
    expect(
      useChatSessionStore.getState().getSession("unloaded"),
    ).toBeUndefined();
  });

  it("hides earlier-query matches during debounce without showing an authoritative zero", async () => {
    mockMessageSearch.results = [
      {
        sessionId: "session",
        title: "Prior query",
        archivedAt: null,
        workingDir: "",
        updatedAt: "2026-04-10T12:00:00Z",
        messageCreatedAt: "2026-04-10T12:00:00Z",
        messageId: "message",
        messageIndex: 0,
        role: "user",
        snippet: "needle",
        matchCount: 1,
      },
    ];
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
    await screen.findByRole("button", {
      name: "Open message 1 in Prior query",
    });
    fireEvent.change(input, { target: { value: "different" } });
    expect(
      screen.queryByRole("button", { name: "Open message 1 in Prior query" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No matches/)).not.toBeInTheDocument();
  });

  it("shows Session Titles and Messages before a query is entered", async () => {
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
    expect(
      screen.getByRole("tab", { name: "Session Titles (0)" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Messages (0)" }));
    expect(
      screen.getByText("Enter keywords to search messages."),
    ).toBeInTheDocument();
  });

  it.each([
    "loading",
    "error",
  ])("reports scoped title zero independently of message search %s", async (state) => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "known-session",
          title: "Unrelated title",
          createdAt: "2026-04-10T12:00:00Z",
          updatedAt: "2026-04-10T12:00:00Z",
          messageCount: 2,
        },
      ],
    });
    mockMessageSearch.isLoading = state === "loading";
    mockMessageSearch.status = state === "error" ? "error" : "idle";
    mockMessageSearch.error = state === "error" ? "unavailable" : null;
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
    fireEvent.change(input, { target: { value: "absent" } });
    await waitFor(() =>
      expect(mockUseMessageSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "absent" }),
      ),
    );
    await userEvent.click(
      screen.getByRole("tab", { name: "Session Titles (0)" }),
    );
    expect(
      screen.getByText('No session titles match "absent"'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('No matches for "absent"'),
    ).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Unrelated" } });
    expect(
      screen.queryByText('No session titles match "absent"'),
    ).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "Open chat Unrelated title" });
    expect(
      screen.queryByText('No session titles match "Unrelated"'),
    ).not.toBeInTheDocument();
  });

  it("reports authoritative zero only when the message search finishes without a cursor", async () => {
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
    fireEvent.change(
      screen.getByRole("textbox", { name: "Universal search" }),
      { target: { value: "absent" } },
    );
    await waitFor(() =>
      expect(mockUseMessageSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "absent" }),
      ),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Messages (0)" }));
    expect(screen.getByText('No matches for "absent"')).toBeInTheDocument();
  });

  it("keeps Messages available with zero results, chooses archive scope and pages results", async () => {
    mockMessageSearch.hasMore = true;
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
    fireEvent.change(
      screen.getByRole("textbox", { name: "Universal search" }),
      { target: { value: "absent" } },
    );
    await waitFor(() =>
      expect(mockUseMessageSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "absent" }),
      ),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Messages (0)" }));
    expect(
      screen.queryByText('No matches for "absent"'),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message scope"), {
      target: { value: "archived" },
    });
    expect(mockUseMessageSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "archived" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Load more messages" }),
    );
    expect(mockMessageSearch.loadMore).toHaveBeenCalledOnce();
  });

  it.each([
    "partial",
    "timeout",
    "error",
  ])("shows %s as incomplete instead of authoritative no matches", async (status) => {
    mockMessageSearch.status = status;
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
    fireEvent.change(
      screen.getByRole("textbox", { name: "Universal search" }),
      { target: { value: "absent" } },
    );
    await waitFor(() =>
      expect(mockUseMessageSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "absent" }),
      ),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Messages (0)" }));
    expect(
      screen.queryByText('No matches for "absent"'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/incomplete/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockMessageSearch.retry).toHaveBeenCalledOnce();
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
