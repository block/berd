import { render, screen } from "@testing-library/react";
import type { ToasterProps } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { Toaster, ToastActionButton } from "./sonner";

const sonnerMocks = vi.hoisted(() => ({
  toaster: vi.fn((_props: ToasterProps) => null),
}));

vi.mock("sonner", () => ({
  Toaster: sonnerMocks.toaster,
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ isDark: false }),
}));

describe("Toaster", () => {
  it("uses CSS variables for composer-aware bottom offsets", () => {
    render(<Toaster />);

    expect(sonnerMocks.toaster.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        offset: { bottom: "var(--toast-bottom-offset)", right: 12 },
        mobileOffset: {
          bottom: "var(--toast-mobile-bottom-offset)",
          left: 16,
          right: 16,
        },
        swipeDirections: ["right", "bottom"],
        toastOptions: expect.objectContaining({
          classNames: expect.objectContaining({
            toast: expect.stringContaining("select-none"),
            content: expect.stringContaining("select-none"),
            title: expect.stringContaining("select-none"),
            description: expect.stringContaining("select-none"),
          }),
        }),
      }),
    );
  });

  it("exposes the shared toast action button rules", () => {
    render(<ToastActionButton>View</ToastActionButton>);

    const button = screen.getByRole("button", { name: "View" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("ml-auto", "shrink-0", "select-none");
    expect(button.querySelector(".absolute.inset-0")).toHaveTextContent("View");
  });
});
