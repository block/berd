import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { IconPlayerPlayFilled } from "@tabler/icons-react";
import { Switch } from "@/shared/ui/switch";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Button } from "@/shared/ui/button";
import {
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from "@/features/settings/lib/notificationPrefs";
import {
  NOTIFICATION_SOUNDS,
  SILENT_NOTIFICATION_SOUND,
  playNotificationSound,
  type NotificationSoundId,
} from "@/shared/notifications/notificationSounds";
import { cn } from "@/shared/lib/cn";

interface SoundOption {
  id: NotificationSoundId;
  label: string;
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
      <div className="divide-y divide-border overflow-hidden rounded-md bg-background">
        {children}
      </div>
    </section>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 px-4 py-4">
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

function SoundRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 pb-4 pt-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-2 w-56">{children}</div>
    </div>
  );
}

function SoundSelect({
  value,
  onValueChange,
  ariaLabel,
  getPreviewAriaLabel,
}: {
  value: NotificationSoundId;
  onValueChange: (value: NotificationSoundId) => void;
  ariaLabel: string;
  getPreviewAriaLabel: (soundLabel: string) => string;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const soundOptions: SoundOption[] = [
    ...NOTIFICATION_SOUNDS.map((sound) => ({
      id: sound.id,
      label: t(sound.labelKey),
    })),
    {
      id: SILENT_NOTIFICATION_SOUND,
      label: t("notifications.sounds.silent"),
    },
  ];
  const selectedSound = soundOptions.find((sound) => sound.id === value);

  function selectSound(sound: NotificationSoundId) {
    onValueChange(sound);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-9 w-full justify-between rounded-sm px-3"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          rightIcon={<ChevronDown aria-hidden="true" />}
        >
          {selectedSound?.label ?? value}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <fieldset className="space-y-0.5">
          <legend className="sr-only">{ariaLabel}</legend>
          {soundOptions.map((sound) => {
            const selected = sound.id === value;
            const playable = sound.id !== SILENT_NOTIFICATION_SOUND;

            return (
              <div
                key={sound.id}
                className={cn(
                  "group flex h-9 items-center gap-2 rounded-sm text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground",
                  selected && "bg-accent text-accent-foreground",
                )}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  className="flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-sm bg-transparent px-2 text-left outline-none"
                  onClick={() => selectSound(sound.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{sound.label}</span>
                </button>
                <span className="ml-auto flex items-center">
                  {playable ? (
                    <span
                      className={cn(
                        "transition-opacity group-hover:opacity-100 focus-within:opacity-100",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                    >
                      <Button
                        type="button"
                        variant="top-bar-icon"
                        size="icon-xs"
                        aria-label={getPreviewAriaLabel(sound.label)}
                        className="size-7"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          playNotificationSound(sound.id);
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <IconPlayerPlayFilled
                          className="size-3"
                          aria-hidden="true"
                        />
                      </Button>
                    </span>
                  ) : (
                    <span className="size-7" aria-hidden="true" />
                  )}
                </span>
              </div>
            );
          })}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

function NotificationChannelSetting({
  label,
  description,
  checked,
  onCheckedChange,
  soundLabel,
  soundAriaLabel,
  soundValue,
  onSoundChange,
  getPreviewAriaLabel,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  soundLabel: string;
  soundAriaLabel: string;
  soundValue: NotificationSoundId;
  onSoundChange: (value: NotificationSoundId) => void;
  getPreviewAriaLabel: (soundLabel: string) => string;
}) {
  return (
    <div>
      <SettingRow label={label} description={description}>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={label}
        />
      </SettingRow>

      {checked && (
        <SoundRow label={soundLabel}>
          <SoundSelect
            value={soundValue}
            onValueChange={onSoundChange}
            ariaLabel={soundAriaLabel}
            getPreviewAriaLabel={getPreviewAriaLabel}
          />
        </SoundRow>
      )}
    </div>
  );
}

export function NotificationSettings() {
  const { t } = useTranslation("settings");
  const [prefs, setPrefs] = useState<NotificationPrefs>(getNotificationPrefs);

  function update(patch: Partial<NotificationPrefs>) {
    setNotificationPrefs(patch);
    setPrefs((current) => ({ ...current, ...patch }));
  }

  return (
    <SettingsPage contentClassName="space-y-8">
      <SettingsSection>
        <SettingRow label={t("notifications.enabled.label")}>
          <Switch
            checked={prefs.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
            aria-label={t("notifications.enabled.label")}
          />
        </SettingRow>
      </SettingsSection>

      {prefs.enabled && (
        <SettingsSection>
          <NotificationChannelSetting
            label={t("notifications.inApp.label")}
            description={t("notifications.inApp.description")}
            checked={prefs.inApp}
            onCheckedChange={(checked) => update({ inApp: checked })}
            soundLabel={t("notifications.inAppSound.label")}
            soundAriaLabel={t("notifications.inAppSound.ariaLabel")}
            soundValue={prefs.inAppSound}
            onSoundChange={(inAppSound) => update({ inAppSound })}
            getPreviewAriaLabel={(sound) =>
              t("notifications.soundPreview.ariaLabel", { sound })
            }
          />

          <NotificationChannelSetting
            label={t("notifications.desktop.label")}
            description={t("notifications.desktop.description")}
            checked={prefs.desktop}
            onCheckedChange={(checked) => update({ desktop: checked })}
            soundLabel={t("notifications.desktopSound.label")}
            soundAriaLabel={t("notifications.desktopSound.ariaLabel")}
            soundValue={prefs.desktopSound}
            onSoundChange={(desktopSound) => update({ desktopSound })}
            getPreviewAriaLabel={(sound) =>
              t("notifications.soundPreview.ariaLabel", { sound })
            }
          />
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
