import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function createMediaQueryList(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(
      (_event: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
    ),
    removeEventListener: vi.fn(
      (_event: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    ),
    dispatchEvent: vi.fn(),
  };

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mediaQuery),
  });

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches: nextMatches } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function ThemeConsumer() {
  const {
    themeMode,
    resolvedTheme,
    isDark,
    primaryColor,
    themePrimaryColor,
    customPrimaryColor,
    setThemeMode,
    setPrimaryColor,
    resetPrimaryColor,
  } = useTheme();

  return (
    <div>
      <span data-testid="theme-mode">{themeMode}</span>
      <span data-testid="resolved-theme">{resolvedTheme}</span>
      <span data-testid="is-dark">{String(isDark)}</span>
      <span data-testid="primary-color">{primaryColor}</span>
      <span data-testid="theme-primary-color">{themePrimaryColor}</span>
      <span data-testid="custom-primary-color">
        {customPrimaryColor ?? "theme"}
      </span>
      <button onClick={() => setThemeMode("system")} type="button">
        Use System
      </button>
      <button onClick={() => setThemeMode("light")} type="button">
        Use Light
      </button>
      <button onClick={() => setThemeMode("dark")} type="button">
        Use Dark
      </button>
      <button onClick={() => setPrimaryColor("#22c55e")} type="button">
        Set Custom Primary
      </button>
      <button onClick={resetPrimaryColor} type="button">
        Reset Primary
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-density");
    document.documentElement.removeAttribute("style");
  });

  it("defaults to system mode and resolves through the OS preference", async () => {
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme-mode")).toHaveTextContent("system");

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    });

    expect(document.documentElement).toHaveClass("light");
    expect(localStorage.getItem("goose-theme-mode")).toBe("system");
  });

  it("reacts to system theme changes while in system mode", async () => {
    const media = createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    });

    act(() => {
      media.setMatches(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
      expect(document.documentElement).toHaveClass("dark");
    });
  });

  it("can pin theme mode to light or dark", async () => {
    const user = userEvent.setup();
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Use Dark" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("dark");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    });

    expect(localStorage.getItem("goose-theme-mode")).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Use Light" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("light");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    });

    expect(localStorage.getItem("goose-theme-mode")).toBe("light");
  });

  it("returns to following the OS when system mode is selected", async () => {
    const user = userEvent.setup();
    const media = createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Use Dark" }));

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    });

    await user.click(screen.getByRole("button", { name: "Use System" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    });

    act(() => {
      media.setMatches(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    });
  });

  it("sets and resets a custom primary color override", async () => {
    const user = userEvent.setup();
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Set Custom Primary" }),
    );

    await waitFor(() => {
      expect(localStorage.getItem("goose-primary-color")).toBe("#22c55e");
      expect(screen.getByTestId("custom-primary-color")).toHaveTextContent(
        "#22c55e",
      );
    });
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#22c55e",
    );
    expect(
      document.documentElement.style.getPropertyValue("--primary-foreground"),
    ).toBe("#000000");

    await user.click(screen.getByRole("button", { name: "Reset Primary" }));

    await waitFor(() => {
      expect(localStorage.getItem("goose-primary-color")).toBeNull();
      expect(screen.getByTestId("custom-primary-color")).toHaveTextContent(
        "theme",
      );
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "",
      );
    });
  });

  it("clears deprecated density preferences", async () => {
    createMediaQueryList(false);
    localStorage.setItem("goose-density", "compact");
    document.documentElement.dataset.density = "compact";

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(localStorage.getItem("goose-density")).toBeNull();
      expect(document.documentElement).not.toHaveAttribute("data-density");
    });
  });
});
