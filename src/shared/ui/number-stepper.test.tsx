import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NumberStepper } from "./number-stepper";

const labels = {
  label: "Font size in pixels",
  decrementLabel: "Decrease font size",
  incrementLabel: "Increase font size",
};

function ControlledStepper({ initial = 16 }: { initial?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberStepper
      {...labels}
      value={value}
      onValueChange={setValue}
      min={8}
      max={72}
      step={1}
      largeStep={4}
      unit="pixels"
    />
  );
}

describe("NumberStepper", () => {
  it("increments and decrements with buttons", () => {
    render(<ControlledStepper />);
    const input = screen.getByRole("spinbutton", { name: labels.label });

    fireEvent.click(
      screen.getByRole("button", { name: labels.incrementLabel }),
    );
    expect(input).toHaveValue("17");
    fireEvent.click(
      screen.getByRole("button", { name: labels.decrementLabel }),
    );
    expect(input).toHaveValue("16");
  });

  it("uses arrow keys and shift for larger steps", () => {
    render(<ControlledStepper />);
    const input = screen.getByRole("spinbutton", { name: labels.label });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("17");
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    expect(input).toHaveValue("21");
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    expect(input).toHaveValue("17");
  });

  it("allows draft typing, clamps on commit, and restores invalid drafts", () => {
    render(<ControlledStepper />);
    const input = screen.getByRole("spinbutton", { name: labels.label });

    fireEvent.change(input, { target: { value: "100" } });
    expect(input).toHaveValue("100");
    fireEvent.blur(input);
    expect(input).toHaveValue("72");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("72");
  });

  it("disables controls at their boundaries", () => {
    const onValueChange = vi.fn();
    render(
      <NumberStepper
        {...labels}
        value={8}
        onValueChange={onValueChange}
        min={8}
        max={72}
      />,
    );

    expect(
      screen.getByRole("button", { name: labels.decrementLabel }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: labels.incrementLabel }),
    ).toBeEnabled();
  });
});
