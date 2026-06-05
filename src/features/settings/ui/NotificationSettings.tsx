import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/shared/ui/switch";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from "@/features/settings/lib/notificationPrefs";

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
          <SettingRow
            label={t("notifications.inApp.label")}
            description={t("notifications.inApp.description")}
          >
            <Switch
              checked={prefs.inApp}
              onCheckedChange={(checked) => update({ inApp: checked })}
              aria-label={t("notifications.inApp.label")}
            />
          </SettingRow>

          <SettingRow
            label={t("notifications.desktop.label")}
            description={t("notifications.desktop.description")}
          >
            <Switch
              checked={prefs.desktop}
              onCheckedChange={(checked) => update({ desktop: checked })}
              aria-label={t("notifications.desktop.label")}
            />
          </SettingRow>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
