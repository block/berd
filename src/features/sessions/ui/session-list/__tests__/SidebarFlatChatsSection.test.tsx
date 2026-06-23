import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { SidebarFlatChatsSection } from "../SidebarFlatChatsSection";

const flatChatGroups = [
  {
    id: "last-hour",
    sessions: [
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        projectId: "project-1",
        projectName: "Project One",
        projectIcon: "",
        projectColor: "",
      },
      {
        id: "general-chat",
        title: "General Chat",
        updatedAt: "2026-04-09T11:00:00.000Z",
      },
    ],
  },
] satisfies FlatChatGroup[];

function renderFlatChatsSection(
  props: Partial<ComponentProps<typeof SidebarFlatChatsSection>> = {},
) {
  return render(
    <SidebarFlatChatsSection
      groups={flatChatGroups}
      collapsed={false}
      labelTransition=""
      labelVisible
      {...props}
    />,
  );
}

describe("SidebarFlatChatsSection", () => {
  it("shows new project and new chat actions in the flat chats header", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();

    renderFlatChatsSection({ onCreateProject, onNewChat });

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("uses icon-only flat chat rows when collapsed", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();
    const onSelectSession = vi.fn();

    const { container } = renderFlatChatsSection({
      collapsed: true,
      activeSessionId: "project-chat",
      onCreateProject,
      onNewChat,
      onSelectSession,
    });

    expect(container.querySelector("[data-sidebar-chat-row]")).toBeNull();
    expect(screen.queryByText("Project Chat")).toBeNull();
    expect(screen.queryByText("General Chat")).toBeNull();
    expect(
      container.querySelector('[data-project-color-swatch="project-1"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project Chat" })).toHaveClass(
      "bg-sidebar-accent",
    );
    expect(
      screen.getByRole("button", { name: "General Chat" }),
    ).not.toHaveClass("bg-sidebar-accent");

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "General Chat" }));

    expect(onSelectSession).toHaveBeenCalledWith("general-chat");
  });

  it("uses an icon-only empty state when collapsed", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();

    const { container } = renderFlatChatsSection({
      collapsed: true,
      groups: [],
      onCreateProject,
      onNewChat,
    });

    expect(screen.queryByText("Start a chat")).toBeNull();
    expect(container.querySelector("[data-sidebar-chat-row]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Start a chat" }));

    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
