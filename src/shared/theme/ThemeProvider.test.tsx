import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import globalsCss from "../styles/globals.css?raw";
import { ThemeProvider, useTheme } from "./ThemeProvider";

const { mockCreateThemeVars, mockExtractThemeInfo, mockLoadThemeData } =
  vi.hoisted(() => ({
    mockCreateThemeVars: vi.fn(),
    mockExtractThemeInfo: vi.fn(),
    mockLoadThemeData: vi.fn(),
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

vi.mock("./theme-loader", () => ({
  extractThemeInfo: mockExtractThemeInfo,
  isSyntaxThemeName: (value: string | null) =>
    value === "houston" || value === "github-light" || value === "dracula",
  loadThemeData: mockLoadThemeData,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

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
    selectedThemeName,
    themeMode,
    usingSystemTheme,
    resolvedThemeName,
    isDark,
    isLoading,
    primaryColor,
    themePrimaryColor,
    customPrimaryColor,
    density,
    setTheme,
    setThemeMode,
    setPrimaryColor,
    resetPrimaryColor,
    setDensity,
  } = useTheme();

  return (
    <div>
      <span data-testid="selected-theme">{selectedThemeName ?? "system"}</span>
      <span data-testid="theme-mode">{themeMode}</span>
      <span data-testid="using-system">{String(usingSystemTheme)}</span>
      <span data-testid="resolved-theme">{resolvedThemeName}</span>
      <span data-testid="is-dark">{String(isDark)}</span>
      <span data-testid="is-loading">{String(isLoading)}</span>
      <span data-testid="primary-color">{primaryColor}</span>
      <span data-testid="theme-primary-color">{themePrimaryColor}</span>
      <span data-testid="custom-primary-color">
        {customPrimaryColor ?? "theme"}
      </span>
      <span data-testid="density">{density}</span>
      <button onClick={() => setTheme("dracula")} type="button">
        Set Dracula
      </button>
      <button onClick={() => setTheme("houston")} type="button">
        Set Houston
      </button>
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

    mockLoadThemeData.mockResolvedValue({});
    mockExtractThemeInfo.mockImplementation((name: string) => ({
      name,
      bg: name === "github-light" ? "#ffffff" : "#111827",
      fg: name === "github-light" ? "#111827" : "#f9fafb",
      comment: name === "github-light" ? "#6b7280" : "#94a3b8",
      primary: name === "github-light" ? "#2188ff" : "#ff79c6",
      added: "#22c55e",
      deleted: "#ef4444",
      modified: "#f59e0b",
    }));
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

    expect(screen.getByTestId("selected-theme")).toHaveTextContent("system");
    expect(screen.getByTestId("theme-mode")).toHaveTextContent("system");
    expect(screen.getByTestId("using-system")).toHaveTextContent("true");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
      "github-light",
    );

    await waitFor(() => {
      expect(screen.getByTestId("is-loading")).toHaveTextContent("false");
    });

    expect(document.documentElement).toHaveClass("light");
    expect(localStorage.getItem("goose-custom-theme")).toBeNull();
    expect(localStorage.getItem("goose-theme-mode")).toBe("system");
  });

  it("reacts to system theme changes while no explicit theme is selected", async () => {
    const media = createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-light",
      );
    });

    act(() => {
      media.setMatches(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-dark",
      );
      expect(document.documentElement).toHaveClass("dark");
    });
  });

  it("can pin the default Goose theme to light or dark", async () => {
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
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-dark",
      );
    });

    expect(localStorage.getItem("goose-theme-mode")).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Use Light" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("light");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-light",
      );
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
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-dark",
      );
    });

    await user.click(screen.getByRole("button", { name: "Use System" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-light",
      );
    });

    media.setMatches(true);

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-dark",
      );
    });
  });

  it("switches to an explicit theme and persists it", async () => {
    const user = userEvent.setup();
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Set Dracula" }));

    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("dracula");
      expect(screen.getByTestId("using-system")).toHaveTextContent("false");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dracula");
    });

    expect(localStorage.getItem("goose-custom-theme")).toBe("dracula");
  });

  it("returns to system mode when the theme is cleared", async () => {
    const user = userEvent.setup();
    localStorage.setItem("goose-custom-theme", "dracula");
    createMediaQueryList(true);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("dracula");
    });

    await user.click(screen.getByRole("button", { name: "Use System" }));

    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-dark",
      );
    });

    expect(localStorage.getItem("goose-custom-theme")).toBeNull();
  });

  it("migrates legacy preset storage to default theme mode", async () => {
    localStorage.setItem("goose-theme", "dark");
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("system");
      expect(screen.getByTestId("theme-mode")).toHaveTextContent("dark");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
        "github-dark",
      );
    });
  });

  it("migrates a legacy named theme into an explicit selection", async () => {
    localStorage.setItem("goose-theme", "dracula");
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("dracula");
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dracula");
    });
  });

  it("applies cached theme vars before the async theme load resolves", () => {
    localStorage.setItem(
      "goose-theme-cache-v3",
      JSON.stringify({
        isDark: true,
        primaryColor: "#ff79c6",
        resolvedThemeName: "dracula",
        themePrimaryColor: "#ff79c6",
        vars: {
          "--background": "240 10% 4%",
          "--foreground": "0 0% 100%",
        },
      }),
    );
    mockLoadThemeData.mockReturnValue(new Promise(() => {}));
    createMediaQueryList(false);

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(document.documentElement).toHaveClass("dark");
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe("240 10% 4%");
    expect(screen.getByTestId("is-dark")).toHaveTextContent("true");
    expect(screen.getByTestId("is-loading")).toHaveTextContent("true");
  });

  it("uses a custom primary color override across theme changes", async () => {
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

    await user.click(screen.getByRole("button", { name: "Set Dracula" }));

    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("dracula");
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
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "326 100% 74%",
    );
  });

  it("uses the selected theme primary when switching themes", async () => {
    const user = userEvent.setup();
    createMediaQueryList(false);
    mockCreateThemeVars.mockImplementation(
      (bg: string, _fg, _comment, _git, primary: string) => ({
        isDark: bg !== "#ffffff",
        vars: {
          "--background": bg === "#ffffff" ? "0 0% 100%" : "224 71% 4%",
          "--foreground": bg === "#ffffff" ? "224 71% 4%" : "0 0% 100%",
          "--primary": primary === "#ff79c6" ? "326 100% 74%" : "210 50% 50%",
          "--primary-foreground": "0 0% 100%",
        },
      }),
    );

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Set Dracula" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("dracula");
    });

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "326 100% 74%",
    );

    await user.click(screen.getByRole("button", { name: "Set Houston" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("houston");
    });

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "326 100% 74%",
    );
  });

  it("falls back to the built-in system theme when async theme loading fails", async () => {
    createMediaQueryList(false);
    mockLoadThemeData.mockRejectedValueOnce(new Error("chunk load failed"));

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("is-loading")).toHaveTextContent("false");
    });

    expect(screen.getByTestId("resolved-theme")).toHaveTextContent(
      "github-light",
    );
    expect(screen.getByTestId("is-dark")).toHaveTextContent("false");
    expect(document.documentElement).toHaveClass("light");
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).not.toBe("");
  });

  it("clears a selected custom theme when loading it fails", async () => {
    localStorage.setItem("goose-custom-theme", "dracula");
    createMediaQueryList(false);
    mockLoadThemeData.mockRejectedValueOnce(new Error("chunk load failed"));

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-theme")).toHaveTextContent("system");
    });

    expect(localStorage.getItem("goose-custom-theme")).toBeNull();
    expect(document.documentElement).toHaveClass("light");
  });

  it("ignores stale theme loads that finish after a newer request", async () => {
    const user = userEvent.setup();
    createMediaQueryList(false);

    const githubLight = createDeferred<Record<string, never>>();
    const dracula = createDeferred<Record<string, never>>();

    mockLoadThemeData.mockImplementation((themeName: string) => {
      if (themeName === "github-light") {
        return githubLight.promise;
      }

      if (themeName === "dracula") {
        return dracula.promise;
      }

      return Promise.resolve({});
    });

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Set Dracula" }));

    dracula.resolve({});

    await waitFor(() => {
      expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dracula");
      expect(document.documentElement).toHaveClass("dark");
    });

    githubLight.resolve({});

    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dracula");
    expect(document.documentElement).toHaveClass("dark");
    expect(
      JSON.parse(localStorage.getItem("goose-theme-cache-v3") ?? "{}"),
    ).toMatchObject({
      resolvedThemeName: "dracula",
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
