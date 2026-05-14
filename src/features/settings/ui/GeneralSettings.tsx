import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { type LocalePreference, useLocale } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Button } from "@/shared/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { resetOnboardingCompletion } from "@/features/onboarding/hooks/useOnboardingGate";
import { ACCENT_COLORS, useTheme } from "@/shared/theme/ThemeProvider";
import { Check, MonitorSmartphone, Moon, Search, Sun } from "lucide-react";
import {
  isLightTheme,
  SYNTAX_THEMES,
  type SyntaxThemeName,
} from "@/shared/theme/theme-loader";
import { IconCheck } from "@tabler/icons-react";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { GooseAutoCompactSettings } from "./GooseAutoCompactSettings";
import { Switch } from "@/shared/ui/switch";
import { useAgentToolsTipsPreference } from "@/features/chat/lib/agentToolsTipPreferences";

const DENSITY_OPTIONS = [
  { value: "compact" },
  { value: "comfortable" },
  { value: "spacious" },
] as const;

function formatThemeLabel(name: string) {
  return name
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

interface AboutAppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  identifier: string;
}

function SettingRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-8 px-4 py-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      {title ? <h4 className="text-sm font-semibold">{title}</h4> : null}
      <div className="overflow-hidden rounded-xl border border-border bg-background divide-y divide-border">
        {children}
      </div>
    </section>
  );
}

function AboutInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium">
        {value}
      </span>
    </div>
  );
}

export function GeneralSettings() {
  const { t } = useTranslation("settings");
  const { preference, setLocalePreference, systemLocaleLabel } = useLocale();
  const [onboardingReset, setOnboardingReset] = useState(false);
  const [appInfo, setAppInfo] = useState<AboutAppInfo | null>(null);
  const agentToolsTipsPreference = useAgentToolsTipsPreference();
  const {
    selectedThemeName,
    usingSystemTheme,
    setTheme,
    accentColorPreference,
    resetAccentColor,
    setAccentColor,
    density,
    setDensity,
  } = useTheme();
  const [themeSearch, setThemeSearch] = useState("");
  const didScrollThemeRef = useRef(false);
  const gooseIcon = getProviderIcon("goose", "size-6");

  const filteredThemes = useMemo(() => {
    const query = themeSearch.toLowerCase().trim();
    if (!query) {
      return SYNTAX_THEMES;
    }

    return SYNTAX_THEMES.filter((themeName) => themeName.includes(query));
  }, [themeSearch]);

  const activeThemeRef = (node: HTMLButtonElement | null) => {
    if (!node || didScrollThemeRef.current) {
      return;
    }

    didScrollThemeRef.current = true;
    node.scrollIntoView({ block: "center" });
  };

  function resetOnboarding() {
    resetOnboardingCompletion();
    setOnboardingReset(true);
  }

  useEffect(() => {
    let cancelled = false;

    async function loadAppInfo() {
      if (!window.__TAURI_INTERNALS__) {
        return;
      }

      try {
        const { getIdentifier, getName, getTauriVersion, getVersion } =
          await import("@tauri-apps/api/app");
        const [name, version, tauriVersion, identifier] = await Promise.all([
          getName(),
          getVersion(),
          getTauriVersion(),
          getIdentifier(),
        ]);

        if (!cancelled) {
          setAppInfo({ name, version, tauriVersion, identifier });
        }
      } catch {
        if (!cancelled) {
          setAppInfo(null);
        }
      }
    }

    void loadAppInfo();

    return () => {
      cancelled = true;
    };
  }, []);

  const aboutFallback = t("about.unavailable");

  return (
    <SettingsPage title={t("general.title")} contentClassName="space-y-8 pt-8">
      <SettingsSection>
        <SettingRow
          label={t("general.language.label")}
          description={t("general.language.description")}
        >
          <Select
            value={preference}
            onValueChange={(value) =>
              void setLocalePreference(value as LocalePreference)
            }
          >
            <SelectTrigger className="w-full min-w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t("general.language.system", {
                  language: systemLocaleLabel,
                })}
              </SelectItem>
              <SelectItem value="en">
                {t("general.language.english")}
              </SelectItem>
              <SelectItem value="es">
                {t("general.language.spanish")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t("general.onboarding.label")}
          description={t(
            onboardingReset
              ? "general.onboarding.resetDescription"
              : "general.onboarding.description",
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resetOnboarding}
          >
            {t("general.onboarding.reset")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("general.agentToolsTips.label")}
          description={t("general.agentToolsTips.description")}
        >
          <Switch
            checked={agentToolsTipsPreference.enabled}
            onCheckedChange={agentToolsTipsPreference.setEnabled}
            aria-label={t("general.agentToolsTips.label")}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("appearance.title")}>
        <div className="space-y-3 px-4 py-4">
          <div>
            <p className="text-sm font-medium">{t("appearance.theme.label")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("appearance.theme.description")}
            </p>
          </div>

          <button
            aria-pressed={usingSystemTheme}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              usingSystemTheme
                ? "border-primary/30 bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
            data-testid="theme-option-system"
            onClick={() => {
              setTheme(null);
            }}
            type="button"
          >
            <MonitorSmartphone className="h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {t("appearance.theme.systemLabel")}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {t("appearance.theme.systemDescription")}
              </div>
            </div>
            {usingSystemTheme ? (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            ) : null}
          </button>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="w-full rounded-lg border border-border/70 bg-background/70 py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="theme-search-input"
              onChange={(event) => {
                didScrollThemeRef.current = false;
                setThemeSearch(event.target.value);
              }}
              placeholder={t("appearance.theme.searchPlaceholder")}
              type="text"
              value={themeSearch}
            />
          </div>

          <div className="max-h-72 overflow-y-auto rounded-lg border border-border/70 bg-background/70">
            {filteredThemes.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                {t("appearance.theme.empty")}
              </p>
            ) : (
              filteredThemes.map((themeName) => {
                const selected = selectedThemeName === themeName;
                const ThemeIcon = isLightTheme(themeName) ? Sun : Moon;

                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    data-testid={`theme-option-${themeName}`}
                    key={themeName}
                    onClick={() => {
                      setTheme(themeName as SyntaxThemeName);
                    }}
                    ref={selected ? activeThemeRef : undefined}
                    type="button"
                  >
                    <ThemeIcon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">
                      {formatThemeLabel(themeName)}
                    </span>
                    {selected ? (
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <SettingRow
          label={t("appearance.accent.label")}
          description={t(
            usingSystemTheme
              ? "appearance.accent.disabledDescription"
              : "appearance.accent.description",
          )}
        >
          <div className="flex max-w-36 flex-wrap justify-end gap-2">
            <button
              type="button"
              title={t("appearance.accent.colors.default")}
              aria-label={t("appearance.accent.colors.default")}
              disabled={usingSystemTheme}
              onClick={resetAccentColor}
              className={cn(
                "relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-border transition-transform hover:scale-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100",
                accentColorPreference === "default" &&
                  "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              data-testid="accent-color-default"
            >
              <span className="absolute inset-0 bg-[linear-gradient(135deg,#1a1a1a_0_50%,#ffffff_50%_100%)]" />
              {accentColorPreference === "default" && (
                <Check className="relative h-4 w-4 rounded-full bg-background p-0.5 text-foreground shadow-none" />
              )}
            </button>
            {ACCENT_COLORS.map((color) => (
              <button
                type="button"
                key={color.value}
                title={t(`appearance.accent.colors.${color.name}`)}
                aria-label={t(`appearance.accent.colors.${color.name}`)}
                disabled={usingSystemTheme}
                onClick={() => setAccentColor(color.value)}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100",
                  accentColorPreference === color.value &&
                    "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
                data-testid={`accent-color-${color.name}`}
                style={{ backgroundColor: color.value }}
              >
                {accentColorPreference === color.value && (
                  <Check className="h-3.5 w-3.5 text-white" />
                )}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          label={t("appearance.density.label")}
          description={t("appearance.density.description")}
        >
          <ToggleGroup
            type="single"
            value={density}
            onValueChange={(v) => v && setDensity(v as typeof density)}
            className="gap-1 rounded-lg bg-muted p-1"
          >
            {DENSITY_OPTIONS.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="rounded-md px-3 py-1.5 text-sm data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-none"
              >
                {t(`appearance.density.options.${option.value}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("compaction.title")}>
        <div className="flex items-start justify-between gap-4 px-4 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex size-6 items-center justify-center [&>*]:size-6">
              {gooseIcon}
            </div>
            <span className="mt-2 block text-sm font-medium">
              {t("compaction.goose.label")}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("compaction.goose.description")}
            </p>
          </div>

          <div className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-1 text-xxs font-medium text-success">
            <IconCheck className="size-3.5" />
            <span>{t("compaction.goose.builtIn")}</span>
          </div>
        </div>

        <div className="px-4 py-4">
          <GooseAutoCompactSettings />
        </div>
      </SettingsSection>

      <SettingsSection title={t("about.title")}>
        <AboutInfoRow
          label={t("about.fields.name")}
          value={appInfo?.name ?? "Goose"}
        />
        <AboutInfoRow
          label={t("about.fields.version")}
          value={appInfo?.version ?? aboutFallback}
        />
        <AboutInfoRow
          label={t("about.fields.buildMode")}
          value={
            import.meta.env.DEV
              ? t("about.buildModes.development")
              : t("about.buildModes.production")
          }
        />
        <AboutInfoRow
          label={t("about.fields.tauriVersion")}
          value={appInfo?.tauriVersion ?? aboutFallback}
        />
        <AboutInfoRow
          label={t("about.fields.identifier")}
          value={appInfo?.identifier ?? aboutFallback}
        />
        <AboutInfoRow label={t("about.fields.license")} value="Apache-2.0" />
      </SettingsSection>
    </SettingsPage>
  );
}
