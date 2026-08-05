import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import { Switch } from "@/shared/ui/switch";

const DEFAULT_THRESHOLD = 0.8;
const MIN_THRESHOLD = 0;
const MAX_THRESHOLD = 1;

export function SecuritySettings() {
  const { t } = useTranslation("settings");
  const [threshold, setThreshold] = useState<string>("");
  const [loadedThreshold, setLoadedThreshold] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<number>("get_security_threshold")
      .then((value) => {
        if (!cancelled) {
          setLoadedThreshold(value);
          setThreshold(String(value));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedThreshold(DEFAULT_THRESHOLD);
          setThreshold(String(DEFAULT_THRESHOLD));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const parsed = Number.parseFloat(threshold);
  const isValid =
    Number.isFinite(parsed) &&
    parsed >= MIN_THRESHOLD &&
    parsed <= MAX_THRESHOLD;
  const isDirty = loadedThreshold !== null && parsed !== loadedThreshold;

  const handleSave = async () => {
    if (!isValid) {
      return;
    }
    setSaving(true);
    try {
      await invoke("set_security_threshold", { threshold: parsed });
      setLoadedThreshold(parsed);
      toast.success(t("security.threshold.saved"));
    } catch {
      toast.error(t("security.threshold.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsPage
      title={t("security.title")}
      description={t("security.description")}
      contentClassName="space-y-8"
    >
      <div className="divide-y divide-border">
        {/* Prompt Injection Detection */}
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              {t("security.promptInjection.label")}
              <Badge variant="default">{t("security.status.active")}</Badge>
            </span>
          }
          description={t("security.promptInjection.description")}
          action={
            <Switch
              checked
              disabled
              aria-label={t("security.promptInjection.label")}
            />
          }
        />

        {/* Command Injection Detection */}
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              {t("security.commandClassifier.label")}
              <Badge variant="default">{t("security.status.active")}</Badge>
            </span>
          }
          description={t("security.commandClassifier.description")}
          action={
            <Switch
              checked
              disabled
              aria-label={t("security.commandClassifier.label")}
            />
          }
        />

        {/* Detection Sensitivity (threshold) */}
        <SettingsRow
          layout="stacked"
          label={t("security.threshold.label")}
          description={t("security.threshold.description")}
          action={
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={MIN_THRESHOLD}
                max={MAX_THRESHOLD}
                step={0.05}
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
                aria-label={t("security.threshold.label")}
                aria-invalid={threshold !== "" && !isValid}
                className="w-28"
              />
              <Button
                type="button"
                variant="primary"
                size="default"
                disabled={!isValid || !isDirty || saving}
                onClick={handleSave}
              >
                {t("security.threshold.save")}
              </Button>
            </div>
          }
          details={
            <>
              {threshold !== "" && !isValid ? (
                <p className="text-xs text-destructive">
                  {t("security.threshold.rangeError")}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t("security.threshold.restartHint")}
              </p>
            </>
          }
        />
      </div>

      <p className="text-xs text-muted-foreground">
        {t("security.managedByOrg")}
        <br />
        {t("security.warpNotice")}
      </p>
    </SettingsPage>
  );
}
