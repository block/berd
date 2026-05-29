import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TopBar } from "../TopBar";

function renderTopBar(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      breadcrumbs={[{ label: "Home" }]}
      onFeedbackClick={vi.fn()}
      {...props}
    />,
  );
}

describe("TopBar", () => {
  it("navigates home when the goose logo is clicked", async () => {
    const user = userEvent.setup();
    const onGoHome = vi.fn();

    renderTopBar({ onGoHome });

    await user.click(screen.getByRole("button", { name: /goose home/i }));

    expect(onGoHome).toHaveBeenCalledOnce();
  });

  it("omits the goose home logo when onGoHome is not provided", () => {
    renderTopBar();

    expect(
      screen.queryByRole("button", { name: /goose home/i }),
    ).not.toBeInTheDocument();
  });
});
