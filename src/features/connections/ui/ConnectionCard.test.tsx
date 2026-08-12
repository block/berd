import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionCard } from "./ConnectionCard";

describe("ConnectionCard", () => {
  it("renders a description and only the supplied row action", () => {
    const onConfigure = vi.fn();

    render(
      <ConnectionCard
        icon={<span aria-hidden="true">C</span>}
        name="Calendar"
        description="Access and manage your calendar"
        action={
          <button type="button" onClick={onConfigure}>
            Configure
          </button>
        }
      />,
    );

    expect(
      screen.getByText("Access and manage your calendar"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Calendar"));
    expect(onConfigure).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(onConfigure).toHaveBeenCalledOnce();
  });
});
