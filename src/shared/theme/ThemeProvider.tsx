import * as React from "react";

import { createThemeVars, normalizeHexColor } from "./adaptive-theme";

type Density = "compact" | "comfortable" | "spacious";
type ThemeMode = "system" | "light" | "dark";

type ThemeProviderProps = {
  children: React.ReactNode;
};

type ThemeProviderState = {
  themeMode: ThemeMode;
  resolvedTheme: "light" | "dark";
  isDark: boolean;
  isLoading: boolean;
  setThemeMode: (themeMode: ThemeMode) => void;
  primaryColor: string;
  themePrimaryColor: string;
  customPrimaryColor: string | null;
  setPrimaryColor: (color: string) => void;
  resetPrimaryColor: () => void;
  density: Density;
  setDensity: (density: Density) => void;
};

type CachedThemeState = {
  isDark: boolean;
  primaryColor: string;
  themePrimaryColor: string;
  vars: Record<string, string>;
};

type FallbackThemeInfo = {
  bg: string;
  fg: string;
  comment: string;
  added: string;
  deleted: string;
  modified: string;
};

const LEGACY_THEME_STORAGE_KEY = "goose-theme";
const THEME_MODE_STORAGE_KEY = "goose-theme-mode";
const THEME_CACHE_STORAGE_KEY = "goose-theme-cache-v3";
const PRIMARY_COLOR_STORAGE_KEY = "goose-primary-color";
const DENSITY_STORAGE_KEY = "goose-density";

const DENSITIES = ["compact", "comfortable", "spacious"] as const;
const THEME_MODES = ["system", "light", "dark"] as const;

const BUILTIN_FALLBACK_THEMES: Record<"light" | "dark", FallbackThemeInfo> = {
  light: {
    bg: "#ffffff",
    fg: "#111827",
    comment: "#6b7280",
    added: "#1a7f37",
    deleted: "#cf222e",
    modified: "#9a6700",
  },
  dark: {
    bg: "#111827",
    fg: "#f9fafb",
    comment: "#94a3b8",
    added: "#3fb950",
    deleted: "#f85149",
    modified: "#d29922",
  },
};

const ThemeProviderContext = React.createContext<
  ThemeProviderState | undefined
>(undefined);

function isDensity(value: string | null): value is Density {
  return DENSITIES.includes(value as Density);
}

function isThemeMode(value: string | null): value is ThemeMode {
  return THEME_MODES.includes(value as ThemeMode);
}

function readSystemThemePreference() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getResolvedMode(
  themeMode: ThemeMode,
  systemPrefersDark: boolean,
): "light" | "dark" {
  if (themeMode === "light" || themeMode === "dark") {
    return themeMode;
  }

  return systemPrefersDark ? "dark" : "light";
}

function applyResolvedMode(isDark: boolean) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(isDark ? "dark" : "light");
  root.style.colorScheme = isDark ? "dark" : "light";
}

function applyCachedTheme(): CachedThemeState | null {
  const cached = window.localStorage.getItem(THEME_CACHE_STORAGE_KEY);
  if (!cached) {
    return null;
  }

  try {
    const parsed = JSON.parse(cached) as CachedThemeState;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(parsed.vars)) {
      root.style.setProperty(key, value);
    }
    applyResolvedMode(parsed.isDark);
    return parsed;
  } catch {
    return null;
  }
}

function applyDensityAttribute(root: HTMLElement, density: Density) {
  if (density === "comfortable") {
    root.removeAttribute("data-density");
  } else {
    root.dataset.density = density;
  }
}

function readInitialThemeMode(): ThemeMode {
  const storedThemeMode = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);

  if (isThemeMode(storedThemeMode)) {
    return storedThemeMode;
  }

  // Best-effort migration from the legacy "goose-theme" key when its value was
  // one of system/light/dark. Legacy named (shiki) presets are intentionally
  // ignored; stale storage keys are left in place.
  const legacyTheme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (isThemeMode(legacyTheme)) {
    return legacyTheme;
  }

  return "system";
}

function buildTheme(
  themeMode: ThemeMode,
  systemPrefersDark: boolean,
  customPrimaryColor: string | null,
): CachedThemeState {
  const resolvedMode = getResolvedMode(themeMode, systemPrefersDark);
  const theme = BUILTIN_FALLBACK_THEMES[resolvedMode];
  const themePrimaryColor = normalizeHexColor(theme.fg) ?? "#3b82f6";
  const primaryColor = customPrimaryColor ?? themePrimaryColor;
  const { isDark, vars } = createThemeVars(
    theme.bg,
    theme.fg,
    theme.comment,
    {
      added: theme.added,
      deleted: theme.deleted,
      modified: theme.modified,
    },
    primaryColor,
    {
      // Light mode keeps the background as the popover surface for parity
      // with the previous Goose-light treatment.
      popoverBackgroundColor: resolvedMode === "light" ? theme.bg : undefined,
    },
  );

  return {
    isDark,
    primaryColor,
    themePrimaryColor,
    vars,
  };
}

function commitTheme(theme: CachedThemeState) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  applyResolvedMode(theme.isDark);
  window.localStorage.setItem(THEME_CACHE_STORAGE_KEY, JSON.stringify(theme));
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const cachedTheme = React.useMemo(() => applyCachedTheme(), []);
  const [themeMode, setThemeModeState] =
    React.useState<ThemeMode>(readInitialThemeMode);
  const [systemPrefersDark, setSystemPrefersDark] = React.useState(
    readSystemThemePreference,
  );
  const [isDark, setIsDark] = React.useState<boolean>(
    cachedTheme?.isDark ??
      document.documentElement.classList.contains("dark") ??
      false,
  );
  const [isLoading, setIsLoading] = React.useState(true);
  const [customPrimaryColor, setCustomPrimaryColor] = React.useState<
    string | null
  >(() =>
    normalizeHexColor(window.localStorage.getItem(PRIMARY_COLOR_STORAGE_KEY)),
  );
  const [themePrimaryColor, setThemePrimaryColor] = React.useState(
    normalizeHexColor(cachedTheme?.themePrimaryColor ?? null) ??
      normalizeHexColor(cachedTheme?.primaryColor ?? null) ??
      "#3b82f6",
  );
  const [density, setDensityState] = React.useState<Density>(() => {
    const storedDensity = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    return isDensity(storedDensity) ? storedDensity : "comfortable";
  });

  const resolvedTheme: "light" | "dark" = isDark ? "dark" : "light";
  const primaryColor = customPrimaryColor ?? themePrimaryColor;

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  React.useEffect(() => {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
  }, [themeMode]);

  React.useEffect(() => {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  }, [density]);

  React.useEffect(() => {
    if (customPrimaryColor) {
      window.localStorage.setItem(
        PRIMARY_COLOR_STORAGE_KEY,
        customPrimaryColor,
      );
    } else {
      window.localStorage.removeItem(PRIMARY_COLOR_STORAGE_KEY);
    }
  }, [customPrimaryColor]);

  React.useEffect(() => {
    setIsLoading(true);
    const nextTheme = buildTheme(
      themeMode,
      systemPrefersDark,
      customPrimaryColor,
    );
    commitTheme(nextTheme);
    setIsDark(nextTheme.isDark);
    setThemePrimaryColor(nextTheme.themePrimaryColor);
    setIsLoading(false);
  }, [customPrimaryColor, systemPrefersDark, themeMode]);

  React.useLayoutEffect(() => {
    applyDensityAttribute(window.document.documentElement, density);
  }, [density]);

  const setThemeMode = React.useCallback((nextThemeMode: ThemeMode) => {
    setThemeModeState(nextThemeMode);
  }, []);

  const setPrimaryColor = React.useCallback((color: string) => {
    const normalizedColor = normalizeHexColor(color);
    if (normalizedColor) {
      setCustomPrimaryColor(normalizedColor);
    }
  }, []);

  const resetPrimaryColor = React.useCallback(() => {
    setCustomPrimaryColor(null);
  }, []);

  const setDensity = React.useCallback((nextDensity: Density) => {
    setDensityState(nextDensity);
  }, []);

  const value = React.useMemo(
    () => ({
      themeMode,
      resolvedTheme,
      isDark,
      isLoading,
      setThemeMode,
      primaryColor,
      themePrimaryColor,
      customPrimaryColor,
      setPrimaryColor,
      resetPrimaryColor,
      density,
      setDensity,
    }),
    [
      customPrimaryColor,
      density,
      isDark,
      isLoading,
      primaryColor,
      resetPrimaryColor,
      resolvedTheme,
      setDensity,
      setPrimaryColor,
      setThemeMode,
      themePrimaryColor,
      themeMode,
    ],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = React.useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
