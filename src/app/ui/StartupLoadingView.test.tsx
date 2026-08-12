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
  it("renders the dot-grid shell and inline Berd loader", () => {
    const { container } = render(<StartupLoadingView />);

    expect(container.firstChild).toHaveClass("bg-dot-grid");
    expect(container.firstChild).toHaveAttribute("data-tauri-drag-region");
    expect(
      container.querySelector('[data-slot="berd-loader"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "startup.loadingLabel",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });
});
