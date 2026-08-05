import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsRow } from "./settings-row";

describe("SettingsRow", () => {
  it("renders an optional description and arbitrary action content", () => {
    const { rerender } = render(
      <SettingsRow
        label="Language"
        action={<button type="button">Change</button>}
      />,
    );

    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.queryByTestId("description")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();

    rerender(
      <SettingsRow
        label="Language"
        description={<span data-testid="description">Used across Berd</span>}
        action={<input aria-label="Language picker" />}
      />,
    );

    expect(screen.getByTestId("description")).toBeInTheDocument();
    expect(screen.getByLabelText("Language picker")).toBeInTheDocument();
  });

  it("exposes stable label and description ids to custom slots", () => {
    render(
      <SettingsRow
        label="Show session cost"
        description="Display estimated cost"
        action={({ labelId, descriptionId }) => (
          <button
            type="button"
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
          >
            Toggle
          </button>
        )}
      />,
    );

    const button = screen.getByRole("button", { name: "Show session cost" });
    expect(button).toHaveAttribute("aria-describedby");
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? ""),
    ).toHaveTextContent("Display estimated cost");
  });

  it("owns a non-customizable normal label weight", () => {
    render(
      <SettingsRow label={<span className="font-bold">Standard label</span>} />,
    );

    const label = screen
      .getByText("Standard label")
      .closest('[data-slot="settings-row-label"]');
    expect(label).toHaveClass("font-normal!", "[&_*]:font-normal!");
  });

  it("does not add left padding", () => {
    render(<SettingsRow label="Aligned row" />);

    expect(
      screen.getByText("Aligned row").closest('[data-slot="settings-row"]'),
    ).not.toHaveClass("pl-4", "px-4");
  });
});
