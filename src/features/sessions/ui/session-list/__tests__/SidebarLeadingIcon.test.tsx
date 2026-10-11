import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarLeadingIcon } from "../SidebarLeadingIcon";

describe("SidebarLeadingIcon activity", () => {
  it("keeps a compact primary-colored indicator mounted from working to unread", () => {
    const props = {
      activeLabel: "Chat active",
      unreadLabel: "Unread messages",
    };
    const { container, rerender } = render(
      <SidebarLeadingIcon {...props} isRunning />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("size-4", "text-primary");
    rerender(<SidebarLeadingIcon {...props} hasUnread />);
    expect(container.querySelector("svg")).toBe(svg);
    expect(screen.getByRole("status")).toHaveAccessibleName("Unread messages");
    rerender(
      <SidebarLeadingIcon {...props}>
        <span>Project identity</span>
      </SidebarLeadingIcon>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Project identity")).toBeInTheDocument();
  });
});
