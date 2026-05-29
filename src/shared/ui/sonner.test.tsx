import { render } from "@testing-library/react";
import type { ToasterProps } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "./sonner";

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
      }),
    );
  });
});
