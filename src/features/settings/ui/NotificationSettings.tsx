import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { IconPlayerPlayFilled } from "@tabler/icons-react";
import { Switch } from "@/shared/ui/switch";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsSection } from "@/shared/ui/settings-section";
import { SettingsRow } from "@/shared/ui/settings-row";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Button } from "@/shared/ui/button";
import { TopBarIconButton } from "@/shared/ui/top-bar-icon-button";
import { Slider } from "@/shared/ui/slider";
import {
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from "@/features/settings/lib/notificationPrefs";
import {
  clampToastDurationSeconds,
  DEFAULT_TOAST_DURATION_SECONDS,
  MIN_TOAST_DURATION_SECONDS,
  MAX_TOAST_DURATION_SECONDS,
  NEVER_DISMISS_TOAST_DURATION_SECONDS,
} from "@/shared/notifications/toastDuration";
import {
  NOTIFICATION_SOUNDS,
  SILENT_NOTIFICATION_SOUND,
  playNotificationSound,
  type NotificationSoundId,
} from "@/shared/notifications/notificationSounds";
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import { recordAssistiveMomentRetired } from "@/shared/assistive-ux/runtime";
import { cn } from "@/shared/lib/cn";

interface SoundOption {
  id: NotificationSoundId;
  label: string;
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
  const soundListId = useId();
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
          aria-controls={soundListId}
          aria-expanded={open}
          aria-label={ariaLabel}
          rightIcon={<ChevronDown aria-hidden="true" />}
        >
          {selectedSound?.label ?? value}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <fieldset id={soundListId} className="space-y-0.5">
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
                      <TopBarIconButton
                        type="button"
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
                      </TopBarIconButton>
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
  extraDetails,
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
  extraDetails?: ReactNode;
}) {
  return (
    <SettingsRow
      label={label}
      description={description}
      action={
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={label}
        />
      }
      details={
        checked ? (
          <div className="w-56 space-y-4">
            <div>
              <p className="text-xs text-muted-foreground">{soundLabel}</p>
              <div className="mt-2">
                <SoundSelect
                  value={soundValue}
                  onValueChange={onSoundChange}
                  ariaLabel={soundAriaLabel}
                  getPreviewAriaLabel={getPreviewAriaLabel}
                />
              </div>
            </div>
            {extraDetails}
          </div>
        ) : undefined
      }
    />
  );
}

function ToastDurationControl({
  label,
  description,
  draftToastDurationSeconds,
  isNeverDismiss,
  onSliderChange,
  onSliderCommit,
  onToggle,
  durationLabel,
  durationLabelId,
}: {
  label: string;
  description: string;
  draftToastDurationSeconds: number;
  isNeverDismiss: boolean;
  onSliderChange: (value: number) => void;
  onSliderCommit: (value: number) => void;
  onToggle: () => void;
  durationLabel: string;
  durationLabelId: string;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-[11px] text-muted-foreground">{description}</p>
      <p id={durationLabelId} className="text-xs text-muted-foreground">
        {durationLabel}
      </p>
      {isNeverDismiss ? null : (
        <Slider
          value={[draftToastDurationSeconds]}
          min={MIN_TOAST_DURATION_SECONDS}
          max={MAX_TOAST_DURATION_SECONDS}
          step={1}
          onValueChange={(values) => onSliderChange(values[0])}
          onValueCommit={(values) => onSliderCommit(values[0])}
          aria-label={label}
          aria-valuetext={durationLabel}
          aria-describedby={durationLabelId}
        />
      )}
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={onToggle}
      >
        {isNeverDismiss
          ? t("notifications.toastDuration.autoDismiss")
          : t("notifications.toastDuration.neverDismiss")}
      </button>
    </div>
  );
}

export function NotificationSettings() {
  const { t } = useTranslation("settings");
  const durationLabelId = useId();
  const [prefs, setPrefs] = useState<NotificationPrefs>(getNotificationPrefs);
  const [draftToastDurationSeconds, setDraftToastDurationSeconds] = useState(
    prefs.toastDurationSeconds,
  );
  // The most recent *timed* duration the user chose, so that leaving
  // never-dismiss restores it instead of resetting to the slider minimum.
  const [lastTimedToastDurationSeconds, setLastTimedToastDurationSeconds] =
    useState(
      prefs.toastDurationSeconds === NEVER_DISMISS_TOAST_DURATION_SECONDS
        ? DEFAULT_TOAST_DURATION_SECONDS
        : prefs.toastDurationSeconds,
    );

  function update(patch: Partial<NotificationPrefs>) {
    setNotificationPrefs(patch);
    recordAssistiveMomentRetired(
      ASSISTIVE_UX_RULES.notificationsChangeSound.id,
      "settingsChanged",
    );
    setPrefs((current) => ({ ...current, ...patch }));
  }

  useEffect(() => {
    setDraftToastDurationSeconds(prefs.toastDurationSeconds);
    if (prefs.toastDurationSeconds !== NEVER_DISMISS_TOAST_DURATION_SECONDS) {
      setLastTimedToastDurationSeconds(prefs.toastDurationSeconds);
    }
  }, [prefs.toastDurationSeconds]);

  function commitToastDurationSeconds(value: number) {
    const clamped = clampToastDurationSeconds(value);
    setDraftToastDurationSeconds(clamped);
    if (clamped !== NEVER_DISMISS_TOAST_DURATION_SECONDS) {
      setLastTimedToastDurationSeconds(clamped);
    }
    update({ toastDurationSeconds: clamped });
  }

  const isNeverDismiss =
    draftToastDurationSeconds === NEVER_DISMISS_TOAST_DURATION_SECONDS;

  const durationLabel = isNeverDismiss
    ? t("notifications.toastDuration.never")
    : t("notifications.toastDuration.seconds", {
        count: draftToastDurationSeconds,
      });

  return (
    <SettingsPage title={t("notifications.title")}>
      <SettingsSection>
        <SettingsRow label={t("notifications.enabled.label")}>
          <Switch
            checked={prefs.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
            aria-label={t("notifications.enabled.label")}
          />
        </SettingsRow>

        {prefs.enabled ? (
          <>
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
              extraDetails={
                // Scoped to the in-app row: this preference only affects the
                // in-app completion banner's dismiss timing, not desktop
                // notifications, so it's only reachable (and only takes
                // effect) while in-app notifications are enabled.
                <ToastDurationControl
                  label={t("notifications.toastDuration.label")}
                  description={t("notifications.toastDuration.description")}
                  draftToastDurationSeconds={draftToastDurationSeconds}
                  isNeverDismiss={isNeverDismiss}
                  onSliderChange={(value) =>
                    setDraftToastDurationSeconds(
                      clampToastDurationSeconds(value),
                    )
                  }
                  onSliderCommit={commitToastDurationSeconds}
                  onToggle={() =>
                    commitToastDurationSeconds(
                      isNeverDismiss
                        ? lastTimedToastDurationSeconds
                        : NEVER_DISMISS_TOAST_DURATION_SECONDS,
                    )
                  }
                  durationLabel={durationLabel}
                  durationLabelId={durationLabelId}
                />
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
          </>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
