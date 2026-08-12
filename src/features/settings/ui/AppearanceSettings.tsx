import { useTranslation } from "react-i18next";
import { Check, Moon, Sun, SunMoon } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { ColorPicker } from "@/shared/ui/color-picker";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { Switch } from "@/shared/ui/switch";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { useAnimatedAvatarsPreference } from "@/shared/avatars/avatarPlaybackPreferences";
import { useWorkingIndicatorAnimationPreference } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";

// Appearance (rev 3): purely visual settings, split out of the old
// GeneralSettings.tsx. Theme is the primary -- first, no sub-header.
export function AppearanceSettings() {
  const { t } = useTranslation("settings");
  const {
    themeMode,
    setThemeMode,
    themePrimaryColor,
    customPrimaryColor,
    setPrimaryColor,
    resetPrimaryColor,
  } = useTheme();
  const animatedAvatarsPreference = useAnimatedAvatarsPreference();
  const workingIndicatorAnimationPreference =
    useWorkingIndicatorAnimationPreference();
  const homePinLabelsPreference = useHomePinLabelsPreference();

  const THEME_PRIMARY_PRESET_ID = "theme";
  const primaryColorPresets = [
    {
      id: THEME_PRIMARY_PRESET_ID,
      label: t("appearance.primary.reset"),
      color: themePrimaryColor,
    },
  ];

  return (
    <SettingsPage title={t("appearance.title")} contentClassName="space-y-8">
      <SettingsSections>
        <SettingsSection>
          <SettingsRow
            layout="stacked"
            label={t("appearance.theme.label")}
            description={t("appearance.theme.description")}
            action={
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
                        "flex min-w-0 items-center gap-3 rounded-md border border-border/70 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
            }
          />

          <SettingsRow
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
          </SettingsRow>

          <SettingsRow
            label={t("appearance.animatedAvatars.label")}
            description={t("appearance.animatedAvatars.description")}
          >
            <Switch
              checked={animatedAvatarsPreference.enabled}
              onCheckedChange={animatedAvatarsPreference.setEnabled}
              aria-label={t("appearance.animatedAvatars.label")}
            />
          </SettingsRow>

          <SettingsRow
            label={t("appearance.workingIndicatorAnimation.label")}
            description={t("appearance.workingIndicatorAnimation.description")}
          >
            <Switch
              checked={workingIndicatorAnimationPreference.enabled}
              onCheckedChange={workingIndicatorAnimationPreference.setEnabled}
              aria-label={t("appearance.workingIndicatorAnimation.label")}
            />
          </SettingsRow>

          <SettingsRow
            label={t("appearance.homePinLabels.label")}
            description={t("appearance.homePinLabels.description")}
          >
            <Switch
              checked={homePinLabelsPreference.enabled}
              onCheckedChange={homePinLabelsPreference.setEnabled}
              aria-label={t("appearance.homePinLabels.label")}
            />
          </SettingsRow>
        </SettingsSection>
      </SettingsSections>
    </SettingsPage>
  );
}
