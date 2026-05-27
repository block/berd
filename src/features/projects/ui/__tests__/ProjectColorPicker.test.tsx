import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectColorPicker } from "../ProjectColorPicker";

describe("ProjectColorPicker", () => {
  it("closes the popover after choosing a preset color", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProjectColorPicker value="olive" onChange={onChange} />);

    await user.click(
      screen.getByRole("button", { name: "Choose a project color" }),
    );
    await user.click(screen.getByRole("button", { name: "Color blue" }));

    expect(onChange).toHaveBeenCalledWith("blue");
    expect(
      screen.queryByRole("button", { name: "Color blue" }),
    ).not.toBeInTheDocument();
  });

  it("opens a constrained custom color picker from the plus swatch", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectColorPicker
        value="olive"
        onChange={onChange}
        variant="swatches"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Custom color" }));

    expect(
      screen.getByRole("heading", { name: "Custom color" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Hue")).toBeInTheDocument();
    expect(screen.getByLabelText("Hex")).toHaveValue("#d6e9b9");
  });

  it("updates the color immediately when the hue changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectColorPicker
        value="olive"
        onChange={onChange}
        variant="swatches"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Custom color" }));
    fireEvent.change(screen.getByLabelText("Hue"), {
      target: { value: "0" },
    });

    expect(onChange).toHaveBeenCalledWith("#e9b9b9");
  });

  it("normalizes typed hex as soon as it is valid", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectColorPicker
        value="olive"
        onChange={onChange}
        variant="swatches"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Custom color" }));
    await user.clear(screen.getByLabelText("Hex"));
    await user.type(screen.getByLabelText("Hex"), "#ff0000");

    expect(onChange).toHaveBeenCalledWith("#e9b9b9");
  });
});
