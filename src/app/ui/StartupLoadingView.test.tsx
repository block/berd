import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StartupLoadingView } from "./StartupLoadingView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("motion/react", () => ({
  useReducedMotion: () => false,
}));

describe("StartupLoadingView", () => {
  it("renders the dot-grid shell and looping goose gif", () => {
    const { container } = render(<StartupLoadingView />);

    expect(container.firstChild).toHaveClass("bg-dot-grid");
    expect(
      container.querySelector('img[src*="startup-loading"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "startup.loadingLabel",
    );
    expect(container.querySelector("video")).toBeNull();
  });
});
