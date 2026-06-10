import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { SearchView } from "../SearchView";

const mockListSkills = vi.hoisted(() => vi.fn());

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
}));

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTiles: vi.fn().mockResolvedValue({ tiles: [] }),
}));

describe("SearchView", () => {
  beforeEach(() => {
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
