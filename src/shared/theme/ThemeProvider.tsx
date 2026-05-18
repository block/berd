import * as React from "react";

import { createThemeVars, normalizeHexColor } from "./adaptive-theme";
import {
  extractThemeInfo,
  isSyntaxThemeName,
  loadThemeData,
  type SyntaxThemeName,
} from "./theme-loader";

type Density = "compact" | "comfortable" | "spacious";
type ThemeMode = "system" | "light" | "dark";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: SyntaxThemeName | "system";
};

type ThemeProviderState = {
  selectedThemeName: SyntaxThemeName | null;
  themeMode: ThemeMode;
  usingSystemTheme: boolean;
  resolvedTheme: "light" | "dark";
  resolvedThemeName: SyntaxThemeName;
  isDark: boolean;
  isLoading: boolean;
  setTheme: (themeName: SyntaxThemeName | null) => void;
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
  resolvedThemeName: SyntaxThemeName;
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
const CUSTOM_THEME_STORAGE_KEY = "goose-custom-theme";
const THEME_CACHE_STORAGE_KEY = "goose-theme-cache-v3";
const PRIMARY_COLOR_STORAGE_KEY = "goose-primary-color";
const DENSITY_STORAGE_KEY = "goose-density";

const DEFAULT_SYSTEM_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

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

function getResolvedDefaultMode(
  themeMode: ThemeMode,
  systemPrefersDark: boolean,
): "light" | "dark" {
  if (themeMode === "light" || themeMode === "dark") {
    return themeMode;
  }

  return systemPrefersDark ? "dark" : "light";
}

function getResolvedThemeName(
  selectedThemeName: SyntaxThemeName | null,
  themeMode: ThemeMode,
  systemPrefersDark: boolean,
): SyntaxThemeName {
  if (selectedThemeName) {
    return selectedThemeName;
  }

  return DEFAULT_SYSTEM_THEMES[
    getResolvedDefaultMode(themeMode, systemPrefersDark)
  ];
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

function readInitialThemeState(
  defaultTheme: SyntaxThemeName | "system",
): SyntaxThemeName | null {
  const storedCustomTheme = window.localStorage.getItem(
    CUSTOM_THEME_STORAGE_KEY,
  );
  const legacyTheme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);

  if (isSyntaxThemeName(storedCustomTheme)) {
    return storedCustomTheme;
  }

  if (isSyntaxThemeName(legacyTheme)) {
    return legacyTheme;
  }

  if (
    legacyTheme === "light" ||
    legacyTheme === "dark" ||
    legacyTheme === "system"
  ) {
    return null;
  }

  return defaultTheme === "system" ? null : defaultTheme;
}

function readInitialThemeMode(): ThemeMode {
  const storedThemeMode = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
  const legacyTheme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);

  if (isThemeMode(storedThemeMode)) {
    return storedThemeMode;
  }

  if (isThemeMode(legacyTheme)) {
    return legacyTheme;
  }

  return "system";
}

async function loadResolvedTheme(
  resolvedThemeName: SyntaxThemeName,
  customPrimaryColor: string | null,
  options: { useGooseLightSurfaces?: boolean } = {},
): Promise<CachedThemeState> {
  const themeData = await loadThemeData(resolvedThemeName);
  const info = extractThemeInfo(resolvedThemeName, themeData);
  const themePrimaryColor =
    normalizeHexColor(info.primary) ?? normalizeHexColor(info.fg) ?? "#3b82f6";
  const primaryColor = customPrimaryColor ?? themePrimaryColor;
  const { isDark, vars } = createThemeVars(
    info.bg,
    info.fg,
    info.comment,
    {
      added: info.added,
      deleted: info.deleted,
      modified: info.modified,
    },
    primaryColor,
    {
      popoverBackgroundColor: options.useGooseLightSurfaces
        ? info.bg
        : undefined,
    },
  );

  return {
    isDark,
    primaryColor,
    resolvedThemeName,
    themePrimaryColor,
    vars,
  };
}

function createFallbackTheme(
  themeMode: ThemeMode,
  systemPrefersDark: boolean,
  customPrimaryColor: string | null,
): CachedThemeState {
  const fallbackMode = getResolvedDefaultMode(themeMode, systemPrefersDark);
  const resolvedThemeName = DEFAULT_SYSTEM_THEMES[fallbackMode];
  const fallbackTheme = BUILTIN_FALLBACK_THEMES[fallbackMode];
  const themePrimaryColor = normalizeHexColor(fallbackTheme.fg) ?? "#3b82f6";
  const primaryColor = customPrimaryColor ?? themePrimaryColor;
  const { isDark, vars } = createThemeVars(
    fallbackTheme.bg,
    fallbackTheme.fg,
    fallbackTheme.comment,
    {
      added: fallbackTheme.added,
      deleted: fallbackTheme.deleted,
      modified: fallbackTheme.modified,
    },
    primaryColor,
    {
      popoverBackgroundColor:
        fallbackMode === "light" ? fallbackTheme.bg : undefined,
    },
  );

  return {
    isDark,
    primaryColor,
    resolvedThemeName,
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

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: ThemeProviderProps) {
  const cachedTheme = React.useMemo(() => applyCachedTheme(), []);
  const initialSelectedTheme = React.useMemo(
    () => readInitialThemeState(defaultTheme),
    [defaultTheme],
  );
  const [selectedThemeName, setSelectedThemeName] =
    React.useState<SyntaxThemeName | null>(initialSelectedTheme);
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

  const usingSystemTheme = selectedThemeName === null;
  const resolvedThemeName = React.useMemo(
    () => getResolvedThemeName(selectedThemeName, themeMode, systemPrefersDark),
    [selectedThemeName, systemPrefersDark, themeMode],
  );
  const themeLoadSignature = `${selectedThemeName ?? "default"}:${themeMode}:${resolvedThemeName}:${systemPrefersDark}:${customPrimaryColor ?? "theme-primary"}`;
  const latestThemeLoadSignatureRef = React.useRef(themeLoadSignature);
  const themeLoadGenerationRef = React.useRef(0);

  if (latestThemeLoadSignatureRef.current !== themeLoadSignature) {
    latestThemeLoadSignatureRef.current = themeLoadSignature;
    themeLoadGenerationRef.current += 1;
  }
  const themeLoadGeneration = themeLoadGenerationRef.current;

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
    if (selectedThemeName) {
      window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, selectedThemeName);
    } else {
      window.localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    }

    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
  }, [selectedThemeName]);

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

    void (async () => {
      let nextTheme: CachedThemeState;
      let shouldClearSelectedTheme = false;

      try {
        nextTheme = await loadResolvedTheme(
          resolvedThemeName,
          customPrimaryColor,
          {
            useGooseLightSurfaces:
              selectedThemeName === null &&
              resolvedThemeName === DEFAULT_SYSTEM_THEMES.light,
          },
        );
      } catch {
        nextTheme = createFallbackTheme(
          themeMode,
          systemPrefersDark,
          customPrimaryColor,
        );
        shouldClearSelectedTheme = selectedThemeName !== null;
      }

      if (themeLoadGenerationRef.current !== themeLoadGeneration) {
        return;
      }

      if (shouldClearSelectedTheme) {
        setSelectedThemeName(null);
        window.localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
      }

      commitTheme(nextTheme);
      setIsDark(nextTheme.isDark);
      setThemePrimaryColor(nextTheme.themePrimaryColor);
      setIsLoading(false);
    })();
  }, [
    customPrimaryColor,
    resolvedThemeName,
    selectedThemeName,
    systemPrefersDark,
    themeMode,
    themeLoadGeneration,
  ]);

  React.useLayoutEffect(() => {
    applyDensityAttribute(window.document.documentElement, density);
  }, [density]);

  const setTheme = React.useCallback((themeName: SyntaxThemeName | null) => {
    setSelectedThemeName(themeName);
  }, []);

  const setThemeMode = React.useCallback((nextThemeMode: ThemeMode) => {
    setThemeModeState(nextThemeMode);
    setSelectedThemeName(null);
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
      selectedThemeName,
      themeMode,
      usingSystemTheme,
      resolvedTheme,
      resolvedThemeName,
      isDark,
      isLoading,
      setTheme,
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
      resolvedThemeName,
      setDensity,
      setPrimaryColor,
      setTheme,
      setThemeMode,
      selectedThemeName,
      themePrimaryColor,
      themeMode,
      usingSystemTheme,
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
