import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  it("renders title-only headers", () => {
    render(<SettingsPage title="General" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "General" }),
    ).toHaveClass("text-xl", "font-medium");
  });

  it("renders description, actions, controls, and children", () => {
    render(
      <SettingsPage
        title="Extensions"
        description="Manage extensions"
        actions={<button type="button">Add</button>}
        controls={<input aria-label="Search extensions" />}
        contentClassName="custom-content"
      >
        <div>Extension list</div>
      </SettingsPage>,
    );

    expect(screen.getByText("Manage extensions")).toHaveClass(
      "text-xs",
      "font-normal",
      "text-muted-foreground",
    );
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search extensions")).toBeInTheDocument();
    expect(screen.getByText("Extension list").parentElement).toHaveClass(
      "custom-content",
    );
  });

  it("uses consistent spacing after headers of any natural height", () => {
    const { rerender } = render(
      <SettingsPage title="General">
        <div>Settings content</div>
      </SettingsPage>,
    );

    expect(screen.getByText("Settings content").parentElement).toHaveClass(
      "pt-6",
    );
    expect(
      screen.getByRole("heading", { name: "General" }).parentElement
        ?.parentElement,
    ).not.toHaveClass("h-24");

    rerender(
      <SettingsPage
        title="Experiments"
        description="Opt into in-progress Berd features on this device. Experiments can change, break, or disappear."
      >
        <div>Settings content</div>
      </SettingsPage>,
    );

    expect(screen.getByText("Settings content").parentElement).toHaveClass(
      "pt-6",
    );
    expect(screen.getByText(/Opt into in-progress/)).not.toHaveClass(
      "line-clamp-2",
    );
  });
});
