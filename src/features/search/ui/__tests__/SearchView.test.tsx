import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { SearchView } from "../SearchView";

const mockListSkills = vi.hoisted(() => vi.fn());
const mockListExtensions = vi.hoisted(() => vi.fn());
const mockGetAutomationTiles = vi.hoisted(() => vi.fn());

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: (...args: unknown[]) => mockListExtensions(...args),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
}));

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: (...args: unknown[]) => mockGetAutomationTiles(...args),
}));

describe("SearchView", () => {
  beforeEach(() => {
    mockListExtensions.mockReset();
    mockListExtensions.mockResolvedValue([]);
    mockGetAutomationTiles.mockReset();
    mockGetAutomationTiles.mockResolvedValue({ tiles: [] });
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
