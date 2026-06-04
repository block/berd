import * as React from "react";

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
};

const THEME_MODE_STORAGE_KEY = "goose-theme-mode";
const PRIMARY_COLOR_STORAGE_KEY = "goose-primary-color";
const DEPRECATED_DENSITY_STORAGE_KEY = "goose-density";
const LEGACY_THEME_CACHE_STORAGE_KEY = "goose-theme-cache-v3";
const LIGHT_THEME_PRIMARY = "#1a1a1a";
const DARK_THEME_PRIMARY = "#ffffff";

const THEME_MODES = ["system", "light", "dark"] as const;

const ThemeProviderContext = React.createContext<
  ThemeProviderState | undefined
>(undefined);

type RGB = {
  r: number;
  g: number;
  b: number;
};

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

function normalizeHexColor(color: string | null): string | null {
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
}

function hexToRgb(hex: string): RGB {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) {
    return { r: 0, g: 0, b: 0 };
  }

  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  };
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const [rs, gs, bs] = [r, g, b].map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getReadableForeground(hexColor: string): "#000000" | "#ffffff" {
  const colorLuminance = luminance(hexColor);
  const contrastWithBlack = (colorLuminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (colorLuminance + 0.05);
  return contrastWithBlack > contrastWithWhite ? "#000000" : "#ffffff";
}

function applyResolvedMode(isDark: boolean) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(isDark ? "dark" : "light");
  root.style.colorScheme = isDark ? "dark" : "light";
}

function readInitialThemeMode(): ThemeMode {
  const storedThemeMode = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);

  if (isThemeMode(storedThemeMode)) {
    return storedThemeMode;
  }

  return "system";
}

function applyPrimaryOverride(color: string | null) {
  const root = document.documentElement;
  const normalizedColor = normalizeHexColor(color);

  if (!normalizedColor) {
    root.style.removeProperty("--primary");
    root.style.removeProperty("--primary-foreground");
    root.style.removeProperty("--sidebar-primary");
    root.style.removeProperty("--sidebar-primary-foreground");
    return;
  }

  const foreground = getReadableForeground(normalizedColor);
  root.style.setProperty("--primary", normalizedColor);
  root.style.setProperty("--primary-foreground", foreground);
  root.style.setProperty("--sidebar-primary", normalizedColor);
  root.style.setProperty("--sidebar-primary-foreground", foreground);
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [themeMode, setThemeModeState] =
    React.useState<ThemeMode>(readInitialThemeMode);
  const [systemPrefersDark, setSystemPrefersDark] = React.useState(
    readSystemThemePreference,
  );
  const [customPrimaryColor, setCustomPrimaryColor] = React.useState<
    string | null
  >(() =>
    normalizeHexColor(window.localStorage.getItem(PRIMARY_COLOR_STORAGE_KEY)),
  );

  const resolvedTheme = getResolvedMode(themeMode, systemPrefersDark);
  const isDark = resolvedTheme === "dark";
  const themePrimaryColor = isDark ? DARK_THEME_PRIMARY : LIGHT_THEME_PRIMARY;
  const primaryColor = customPrimaryColor ?? themePrimaryColor;

  React.useEffect(() => {
    window.localStorage.removeItem(LEGACY_THEME_CACHE_STORAGE_KEY);
    window.localStorage.removeItem(DEPRECATED_DENSITY_STORAGE_KEY);
    window.document.documentElement.removeAttribute("data-density");
  }, []);

  React.useLayoutEffect(() => {
    applyResolvedMode(isDark);
  }, [isDark]);

  React.useLayoutEffect(() => {
    applyPrimaryOverride(customPrimaryColor);
  }, [customPrimaryColor]);

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
    if (customPrimaryColor) {
      window.localStorage.setItem(
        PRIMARY_COLOR_STORAGE_KEY,
        customPrimaryColor,
      );
    } else {
      window.localStorage.removeItem(PRIMARY_COLOR_STORAGE_KEY);
    }
  }, [customPrimaryColor]);

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

  const value = React.useMemo(
    () => ({
      themeMode,
      resolvedTheme,
      isDark,
      isLoading: false,
      setThemeMode,
      primaryColor,
      themePrimaryColor,
      customPrimaryColor,
      setPrimaryColor,
      resetPrimaryColor,
    }),
    [
      customPrimaryColor,
      isDark,
      primaryColor,
      resetPrimaryColor,
      resolvedTheme,
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
