import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
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
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("security.title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("security.description")}
        </p>
      </div>

      <div className="space-y-4">
        {/* Prompt Injection Detection */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {t("security.promptInjection.label")}
              </span>
              <Badge variant="default">{t("security.status.active")}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("security.promptInjection.description")}
            </p>
          </div>
          <Switch
            checked
            disabled
            aria-label={t("security.promptInjection.label")}
          />
        </div>

        {/* Command Injection Detection */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {t("security.commandClassifier.label")}
              </span>
              <Badge variant="default">{t("security.status.active")}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("security.commandClassifier.description")}
            </p>
          </div>
          <Switch
            checked
            disabled
            aria-label={t("security.commandClassifier.label")}
          />
        </div>

        {/* Detection Sensitivity (threshold) */}
        <div className="rounded-lg border p-4 space-y-3">
          <div className="space-y-0.5">
            <span className="text-sm font-medium">
              {t("security.threshold.label")}
            </span>
            <p className="text-xs text-muted-foreground">
              {t("security.threshold.description")}
            </p>
          </div>
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
              variant="default"
              size="default"
              disabled={!isValid || !isDirty || saving}
              onClick={handleSave}
            >
              {t("security.threshold.save")}
            </Button>
          </div>
          {threshold !== "" && !isValid && (
            <p className="text-xs text-destructive">
              {t("security.threshold.rangeError")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("security.threshold.restartHint")}
          </p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("security.managedByOrg")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("security.warpNotice")}
      </p>
    </div>
  );
}
