import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { ButtonGroup } from "@/shared/ui/button-group";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { Check, MonitorSmartphone, Moon, Sun, Trash2 } from "lucide-react";
import { IconCheck } from "@tabler/icons-react";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { GooseAutoCompactSettings } from "./GooseAutoCompactSettings";
import { Switch } from "@/shared/ui/switch";
import { useAgentToolsTipsPreference } from "@/features/chat/lib/agentToolsTipPreferences";
import { useAnimatedAvatarsPreference } from "@/shared/avatars/avatarPlaybackPreferences";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { clearLocalMediaCaches } from "@/shared/api/localMediaCaches";

const DENSITY_OPTIONS = [
  { value: "compact" },
  { value: "comfortable" },
  { value: "spacious" },
] as const;

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
  const [appInfo, setAppInfo] = useState<AboutAppInfo | null>(null);
  const [clearCacheDialogOpen, setClearCacheDialogOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const agentToolsTipsPreference = useAgentToolsTipsPreference();
  const animatedAvatarsPreference = useAnimatedAvatarsPreference();
  const {
    themeMode,
    setThemeMode,
    primaryColor,
    customPrimaryColor,
    setPrimaryColor,
    resetPrimaryColor,
    density,
    setDensity,
  } = useTheme();
  const gooseIcon = getProviderIcon("goose", "size-6");

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

  async function handleClearMediaCache() {
    setClearingCache(true);
    try {
      await clearLocalMediaCaches();
      toast.success(t("storage.cachedMedia.success"));
      setClearCacheDialogOpen(false);
    } catch (error) {
      console.warn("Failed to clear local media caches:", error);
      toast.error(t("storage.cachedMedia.error"));
    } finally {
      setClearingCache(false);
    }
  }

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

          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                {
                  value: "system",
                  icon: MonitorSmartphone,
                  label: t("appearance.theme.systemLabel"),
                  description: t("appearance.theme.systemDescription"),
                },
                {
                  value: "light",
                  icon: Sun,
                  label: t("appearance.theme.lightLabel"),
                  description: t("appearance.theme.lightDescription"),
                },
                {
                  value: "dark",
                  icon: Moon,
                  label: t("appearance.theme.darkLabel"),
                  description: t("appearance.theme.darkDescription"),
                },
              ] as const
            ).map((option) => {
              const selected = themeMode === option.value;
              const ThemeIcon = option.icon;

              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-primary/30 bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  data-testid={`theme-option-${option.value}`}
                  key={option.value}
                  onClick={() => {
                    setThemeMode(option.value);
                  }}
                  type="button"
                >
                  <ThemeIcon className="h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{option.label}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {option.description}
                    </div>
                  </div>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <SettingRow
          label={t("appearance.animatedAvatars.label")}
          description={t("appearance.animatedAvatars.description")}
        >
          <Switch
            checked={animatedAvatarsPreference.enabled}
            onCheckedChange={animatedAvatarsPreference.setEnabled}
            aria-label={t("appearance.animatedAvatars.label")}
          />
        </SettingRow>

        <SettingRow
          label={t("appearance.primary.label")}
          description={t("appearance.primary.description")}
        >
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="primary-color-input">
              {t("appearance.primary.label")}
            </label>
            <input
              className="h-9 w-12 cursor-pointer rounded-lg border border-border bg-background p-1"
              data-testid="primary-color-input"
              id="primary-color-input"
              onChange={(event) => setPrimaryColor(event.target.value)}
              type="color"
              value={primaryColor}
            />
            <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {customPrimaryColor
                ? t("appearance.primary.custom")
                : t("appearance.primary.theme")}
            </span>
            <Button
              data-testid="primary-color-reset"
              disabled={!customPrimaryColor}
              onClick={resetPrimaryColor}
              size="xs"
              type="button"
              variant="outline"
            >
              {t("appearance.primary.reset")}
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label={t("appearance.density.label")}
          description={t("appearance.density.description")}
        >
          <ButtonGroup aria-label={t("appearance.density.label")}>
            {DENSITY_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={density === option.value ? "secondary" : "outline"}
                aria-pressed={density === option.value}
                onClick={() => setDensity(option.value)}
              >
                {t(`appearance.density.options.${option.value}`)}
              </Button>
            ))}
          </ButtonGroup>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("storage.title")}>
        <SettingRow
          label={t("storage.cachedMedia.label")}
          description={t("storage.cachedMedia.description")}
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => setClearCacheDialogOpen(true)}
          >
            <Trash2 className="size-4" />
            {t("storage.cachedMedia.clear")}
          </Button>
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

      <ConfirmDialog
        open={clearCacheDialogOpen}
        onOpenChange={setClearCacheDialogOpen}
        title={t("storage.cachedMedia.confirmTitle")}
        description={t("storage.cachedMedia.confirmDescription")}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("storage.cachedMedia.confirm")}
        loadingLabel={t("storage.cachedMedia.clearing")}
        isLoading={clearingCache}
        onConfirm={handleClearMediaCache}
      />
    </SettingsPage>
  );
}
