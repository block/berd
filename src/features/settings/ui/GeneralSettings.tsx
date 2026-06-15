import { ColorPicker } from "@/shared/ui/color-picker";
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
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useTheme } from "@/shared/theme/ThemeProvider";
import {
  Check,
  FolderOpen,
  Moon,
  RotateCcw,
  Sun,
  SunMoon,
  Trash2,
} from "lucide-react";
import { IconCheck } from "@tabler/icons-react";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { GooseAutoCompactSettings } from "./GooseAutoCompactSettings";
import { Switch } from "@/shared/ui/switch";
import { useAgentToolsTipsPreference } from "@/features/chat/lib/agentToolsTipPreferences";
import { useAnimatedAvatarsPreference } from "@/shared/avatars/avatarPlaybackPreferences";
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { clearLocalMediaCaches } from "@/shared/api/localMediaCaches";
import { useArtifactRootPreference } from "@/shared/artifacts/useArtifactRootPreference";
import { useTerminalFallbackCwdPreference } from "@/features/terminal/lib/terminalCwdPreference";
import {
  useStreamingShortcutPreference,
  type StreamingShortcutMode,
} from "@/features/chat/lib/streamingShortcutPreference";
import { useAtMentionDefaultCategoryPreference } from "@/features/chat/lib/mentionPreference";

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
        <p className="text-sm">{label}</p>
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
      {title ? <h4 className="text-base text-foreground">{title}</h4> : null}
      <div className="overflow-hidden rounded-md bg-background divide-y divide-border">
        {children}
      </div>
    </section>
  );
}

function AboutInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm">{value}</span>
    </div>
  );
}

export function GeneralSettings() {
  const { t } = useTranslation(["settings", "shortcuts"]);
  const { preference, setLocalePreference, systemLocaleLabel } = useLocale();
  const [appInfo, setAppInfo] = useState<AboutAppInfo | null>(null);
  const [clearCacheDialogOpen, setClearCacheDialogOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const agentToolsTipsPreference = useAgentToolsTipsPreference();
  const streamingShortcutPreference = useStreamingShortcutPreference();
  const {
    category: atMentionDefaultCategory,
    setCategory: setAtMentionDefaultCategory,
  } = useAtMentionDefaultCategoryPreference();
  const animatedAvatarsPreference = useAnimatedAvatarsPreference();
  const homePinLabelsPreference = useHomePinLabelsPreference();
  const artifactRootPreference = useArtifactRootPreference();
  const terminalFallbackCwdPreference = useTerminalFallbackCwdPreference();
  const {
    themeMode,
    setThemeMode,
    themePrimaryColor,
    customPrimaryColor,
    setPrimaryColor,
    resetPrimaryColor,
  } = useTheme();
  const followUpBehavior =
    streamingShortcutPreference.mode === "cmd-enter-steers" ? "queue" : "steer";

  // The picker is self-contained: a "follow theme" swatch (clears the custom
  // override so the primary tracks the active light/dark theme) plus the
  // built-in custom-color swatch. No separate status label or reset button.
  const THEME_PRIMARY_PRESET_ID = "theme";
  const primaryColorPresets = [
    {
      id: THEME_PRIMARY_PRESET_ID,
      label: t("appearance.primary.reset"),
      color: themePrimaryColor,
    },
  ];
  const gooseIcon = getProviderIcon("goose", "size-6");
  const terminalFallbackPath =
    terminalFallbackCwdPreference.fallbackCwd ??
    artifactRootPreference.rootPath;

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

  async function handleChooseArtifactRoot() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: artifactRootPreference.rootPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("general.artifacts.chooseDialogTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      await artifactRootPreference.setRootPath(selected);
      toast.success(t("general.artifacts.saveSuccess"));
    } catch (error) {
      console.warn("Failed to choose artifact folder:", error);
      toast.error(t("general.artifacts.saveError"));
    }
  }

  async function handleResetArtifactRoot() {
    try {
      await artifactRootPreference.resetRootPath();
      toast.success(t("general.artifacts.resetSuccess"));
    } catch (error) {
      console.warn("Failed to reset artifact folder:", error);
      toast.error(t("general.artifacts.saveError"));
    }
  }

  async function handleChooseTerminalFallbackCwd() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: terminalFallbackPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("general.terminalFallback.chooseDialogTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      terminalFallbackCwdPreference.setFallbackCwd(selected);
      toast.success(t("general.terminalFallback.saveSuccess"));
    } catch (error) {
      console.warn("Failed to choose terminal fallback folder:", error);
      toast.error(t("general.terminalFallback.saveError"));
    }
  }

  function handleResetTerminalFallbackCwd() {
    try {
      terminalFallbackCwdPreference.resetFallbackCwd();
      toast.success(t("general.terminalFallback.resetSuccess"));
    } catch (error) {
      console.warn("Failed to reset terminal fallback folder:", error);
      toast.error(t("general.terminalFallback.saveError"));
    }
  }

  return (
    <SettingsPage contentClassName="space-y-8">
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
          label={t("general.artifacts.label")}
          description={t("general.artifacts.description")}
          className="items-start"
        >
          <div className="flex max-w-80 flex-col items-end gap-2">
            <p
              className="max-w-80 truncate text-right text-xs text-muted-foreground"
              title={artifactRootPreference.rootPath ?? undefined}
            >
              {artifactRootPreference.rootPath ??
                t("general.artifacts.loading")}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void handleResetArtifactRoot()}
                disabled={!artifactRootPreference.hasCustomRoot}
              >
                <RotateCcw className="size-3.5" />
                {t("general.artifacts.reset")}
              </Button>
              <Button
                type="button"
                variant="default"
                size="xs"
                onClick={() => void handleChooseArtifactRoot()}
              >
                <FolderOpen className="size-3.5" />
                {t("general.artifacts.change")}
              </Button>
            </div>
          </div>
        </SettingRow>

        <SettingRow
          label={t("general.terminalFallback.label")}
          description={t("general.terminalFallback.description")}
          className="items-start"
        >
          <div className="flex max-w-80 flex-col items-end gap-2">
            <p
              className="max-w-80 truncate text-right text-xs text-muted-foreground"
              title={terminalFallbackPath ?? undefined}
            >
              {terminalFallbackPath ?? t("general.terminalFallback.loading")}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={handleResetTerminalFallbackCwd}
                disabled={!terminalFallbackCwdPreference.hasCustomFallbackCwd}
              >
                <RotateCcw className="size-3.5" />
                {t("general.terminalFallback.reset")}
              </Button>
              <Button
                type="button"
                variant="default"
                size="xs"
                onClick={() => void handleChooseTerminalFallbackCwd()}
              >
                <FolderOpen className="size-3.5" />
                {t("general.terminalFallback.change")}
              </Button>
            </div>
          </div>
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

        <SettingRow
          label={t("shortcuts:settings.label")}
          description={t("shortcuts:settings.description")}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => requestOpenSettings("shortcuts")}
          >
            {t("shortcuts:settings.customize")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("general.followUpBehavior.label")}
          description={t("general.followUpBehavior.description")}
        >
          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">
              {t("general.followUpBehavior.label")}
            </legend>
            <Button
              type="button"
              aria-pressed={followUpBehavior === "queue"}
              className="min-w-16"
              size="sm"
              variant={followUpBehavior === "queue" ? "default" : "ghost"}
              onClick={() =>
                streamingShortcutPreference.setMode(
                  "cmd-enter-steers" satisfies StreamingShortcutMode,
                )
              }
            >
              {t("general.followUpBehavior.queue")}
            </Button>
            <Button
              type="button"
              aria-pressed={followUpBehavior === "steer"}
              className="min-w-16"
              size="sm"
              variant={followUpBehavior === "steer" ? "default" : "ghost"}
              onClick={() =>
                streamingShortcutPreference.setMode(
                  "enter-steers" satisfies StreamingShortcutMode,
                )
              }
            >
              {t("general.followUpBehavior.steer")}
            </Button>
          </fieldset>
        </SettingRow>

        <SettingRow
          label={t("general.atMentionDefault.label")}
          description={t("general.atMentionDefault.description")}
        >
          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">
              {t("general.atMentionDefault.label")}
            </legend>
            <Button
              type="button"
              aria-pressed={atMentionDefaultCategory === "agents"}
              className="min-w-16"
              size="sm"
              variant={
                atMentionDefaultCategory === "agents" ? "default" : "ghost"
              }
              onClick={() => setAtMentionDefaultCategory("agents")}
            >
              {t("general.atMentionDefault.agents")}
            </Button>
            <Button
              type="button"
              aria-pressed={atMentionDefaultCategory === "files"}
              className="min-w-16"
              size="sm"
              variant={
                atMentionDefaultCategory === "files" ? "default" : "ghost"
              }
              onClick={() => setAtMentionDefaultCategory("files")}
            >
              {t("general.atMentionDefault.files")}
            </Button>
          </fieldset>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("appearance.title")}>
        <div className="space-y-3 px-4 py-4">
          <div>
            <p className="text-sm">{t("appearance.theme.label")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("appearance.theme.description")}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                {
                  value: "system",
                  icon: SunMoon,
                  label: t("appearance.theme.systemLabel"),
                  description: t("appearance.theme.systemDescription"),
                },
                {
                  value: "light",
                  icon: Sun,
                  label: t("appearance.theme.lightLabel"),
                },
                {
                  value: "dark",
                  icon: Moon,
                  label: t("appearance.theme.darkLabel"),
                },
              ] satisfies ReadonlyArray<{
                value: "system" | "light" | "dark";
                icon: typeof SunMoon;
                label: string;
                description?: string;
              }>
            ).map((option) => {
              const selected = themeMode === option.value;
              const ThemeIcon = option.icon;

              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                    <div className="truncate">{option.label}</div>
                    {option.description ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {option.description}
                      </div>
                    ) : null}
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
          label={t("appearance.homePinLabels.label")}
          description={t("appearance.homePinLabels.description")}
        >
          <Switch
            checked={homePinLabelsPreference.enabled}
            onCheckedChange={homePinLabelsPreference.setEnabled}
            aria-label={t("appearance.homePinLabels.label")}
          />
        </SettingRow>

        <SettingRow
          label={t("appearance.primary.label")}
          description={t("appearance.primary.description")}
        >
          <ColorPicker
            value={customPrimaryColor ?? THEME_PRIMARY_PRESET_ID}
            onChange={(value) =>
              value === THEME_PRIMARY_PRESET_ID
                ? resetPrimaryColor()
                : setPrimaryColor(value)
            }
            label={t("appearance.primary.label")}
            presets={primaryColorPresets}
            customColorLabel={t("appearance.primary.custom")}
            swatchSize="sm"
            variant="swatches"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("storage.title")}>
        <SettingRow
          label={t("storage.cachedMedia.label")}
          description={t("storage.cachedMedia.description")}
        >
          <Button
            type="button"
            variant="default"
            size="xs"
            onClick={() => setClearCacheDialogOpen(true)}
          >
            <Trash2 className="size-3.5" />
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
            <span className="mt-2 block text-sm">
              {t("compaction.goose.label")}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("compaction.goose.description")}
            </p>
          </div>

          <div className="inline-flex items-center gap-1 rounded-xs bg-success/10 px-2 py-1 text-xxs font-medium text-success">
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
