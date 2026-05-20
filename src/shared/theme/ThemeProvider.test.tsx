import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import globalsCss from "../styles/globals.css?raw";
import { ThemeProvider, useTheme } from "./ThemeProvider";

const { mockCreateThemeVars } = vi.hoisted(() => ({
  mockCreateThemeVars: vi.fn(),
}));

vi.mock("./adaptive-theme", () => ({
  createThemeVars: mockCreateThemeVars,
  hexToHsl: vi.fn((hex: string) => {
    const normalized = hex.toLowerCase();
    if (normalized === "#ffffff") {
      return "0 0% 100%";
    }
    if (normalized === "#000000") {
      return "0 0% 0%";
    }
    if (normalized === "#ef4444") {
      return "0 84.2% 60.2%";
    }
    if (normalized === "#22c55e") {
      return "142.1 70.6% 45.3%";
    }
    return "217.2 91.2% 59.8%";
  }),
  normalizeHexColor: vi.fn((color: string | null) => {
    const value = color?.trim();
    if (!value) return null;
    const hex = value.startsWith("#") ? value.slice(1) : value;
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      return `#${hex
        .split("")
        .map((char) => char + char)
        .join("")
        .toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return `#${hex.toLowerCase()}`;
    }
    return null;
  }),
}));

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
    density,
    setThemeMode,
    setPrimaryColor,
    resetPrimaryColor,
    setDensity,
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
      <span data-testid="density">{density}</span>
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
      <button onClick={() => setDensity("compact")} type="button">
        Set Compact
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

    mockCreateThemeVars.mockImplementation(
      (bg: string, _fg, _comment, _git, primary = "#2188ff") => ({
        isDark: bg !== "#ffffff",
        vars: {
          "--background": bg === "#ffffff" ? "0 0% 100%" : "224 71% 4%",
          "--foreground": bg === "#ffffff" ? "224 71% 4%" : "0 0% 100%",
          "--primary":
            primary === "#22c55e"
              ? "142.1 70.6% 45.3%"
              : primary === "#ff79c6"
                ? "326 100% 74%"
                : "210 50% 50%",
          "--primary-foreground": "0 0% 100%",
        },
      }),
    );
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

  it("migrates legacy system/light/dark storage to theme mode", async () => {
    localStorage.setItem("goose-theme", "dark");
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("dark");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    });
  });

  it("applies the cached dark class on mount when a dark theme was persisted", () => {
    // Persisted cache indicates dark; system preference also dark so the
    // post-mount derivation lines up with the cached dark mode.
    localStorage.setItem(
      "goose-theme-cache-v3",
      JSON.stringify({
        isDark: true,
        primaryColor: "#ff79c6",
        themePrimaryColor: "#ff79c6",
        vars: {
          "--background": "240 10% 4%",
          "--foreground": "0 0% 100%",
        },
      }),
    );
    createMediaQueryList(true);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByTestId("is-dark")).toHaveTextContent("true");
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
      "142.1 70.6% 45.3%",
    );

    await user.click(screen.getByRole("button", { name: "Reset Primary" }));

    await waitFor(() => {
      expect(localStorage.getItem("goose-primary-color")).toBeNull();
      expect(screen.getByTestId("custom-primary-color")).toHaveTextContent(
        "theme",
      );
    });
  });

  it("updates density and persists it", async () => {
    const user = userEvent.setup();
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Set Compact" }));

    await waitFor(() => {
      expect(screen.getByTestId("density")).toHaveTextContent("compact");
      expect(localStorage.getItem("goose-density")).toBe("compact");
      expect(document.documentElement.dataset.density).toBe("compact");
    });
  });

  it("keeps density spacing values in CSS", () => {
    expect(globalsCss).toContain('[data-density="compact"]');
    expect(globalsCss).toContain("--density-spacing: 0.75;");
    expect(globalsCss).toContain("--spacing: 0.1875rem;");
    expect(globalsCss).toContain('[data-density="spacious"]');
    expect(globalsCss).toContain("--density-spacing: 1.25;");
    expect(globalsCss).toContain("--spacing: 0.3125rem;");
    expect(globalsCss).toContain(
      "padding: calc(0.5rem * var(--density-spacing));",
    );
  });
});
