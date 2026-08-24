import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";
import { SettingsRow } from "@/shared/ui/settings-row";
import type { MacSpeechSetup } from "../hooks/useMacSpeechSetup";

export function MacSpeechSettings({ setup }: { setup: MacSpeechSetup }) {
  const { t } = useTranslation("settings");
  const { status } = setup;
  if (setup.loading && !status) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {t("voice.macSpeechLoading")}
      </p>
    );
  }
  if (!status?.supported) {
    return null;
  }
  if (status.modelInstalled) {
    return null;
  }

  const locale = status.locale ?? t("voice.macSpeechSystemLocale");
  const error = setup.error ?? status.error;
  return (
    <div className="space-y-3 overflow-hidden">
      <SettingsRow
        label={t("voice.macSpeechModel")}
        description={t("voice.macSpeechNotInstalled", { locale })}
        action={
          status.installing ? undefined : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<Download />}
              disabled={!status.localeSupported}
              onClick={() => void setup.install()}
            >
              {error ? t("voice.retryDownload") : t("voice.download")}
            </Button>
          )
        }
        details={
          status.installing ? (
            <div className="space-y-1" aria-live="polite">
              <Progress value={(status.progress ?? 0) * 100} />
              <p className="text-xs text-muted-foreground">
                {t("voice.macSpeechDownloading", {
                  progress: Math.round((status.progress ?? 0) * 100),
                })}
              </p>
            </div>
          ) : !status.localeSupported ? (
            <p className="text-xs text-destructive" role="alert">
              {t("voice.macSpeechLocaleUnsupported", { locale })}
            </p>
          ) : error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : undefined
        }
      />
    </div>
  );
}
