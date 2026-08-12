import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { Switch } from "@/shared/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  clearUserTrustedDomains,
  getUserTrustedDomains,
  untrustDomain,
} from "@/shared/lib/trustedDomains";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";

const DEFAULT_THRESHOLD = 0.8;
const MIN_THRESHOLD = 0;
const MAX_THRESHOLD = 1;

// Security (rev 3): now a permanent section, not gated behind the whole-
// section `securityMl` build flag. Trusted link domains -- previously
// buried in General/Storage -- moved in as real, always-available content,
// so the section has something for everyone even without the ML build
// flag. The ML rows (prompt injection, command classifier, threshold) stay
// gated *inside* the page.
export function SecuritySettings() {
  const { t } = useTranslation("settings");
  const securityMlEnabled = getBuildFeatureState().securityMl;
  const [threshold, setThreshold] = useState<string>("");
  const [loadedThreshold, setLoadedThreshold] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [trustedDomainsDialogOpen, setTrustedDomainsDialogOpen] =
    useState(false);
  const [trustedDomains, setTrustedDomains] = useState<string[]>(() =>
    getUserTrustedDomains(),
  );

  useEffect(() => {
    if (!securityMlEnabled) {
      return;
    }
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
  }, [securityMlEnabled]);

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

  const refreshTrustedDomains = useCallback(() => {
    setTrustedDomains(getUserTrustedDomains());
  }, []);

  function handleRemoveTrustedDomain(domain: string) {
    untrustDomain(domain);
    refreshTrustedDomains();
    toast.success(t("storage.trustedDomains.removeSuccess", { domain }));
  }

  function handleClearTrustedDomains() {
    clearUserTrustedDomains();
    refreshTrustedDomains();
    toast.success(t("storage.trustedDomains.clearSuccess"));
  }

  const trustedDomainsCount = t("storage.trustedDomains.count", {
    count: trustedDomains.length,
  });

  return (
    <SettingsPage
      title={t("security.title")}
      description={t("security.description")}
      contentClassName="space-y-8"
    >
      <SettingsSections>
        <SettingsSection>
          <SettingsRow
            label={t("storage.trustedDomains.label")}
            description={t("storage.trustedDomains.description")}
          >
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {trustedDomainsCount}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setTrustedDomainsDialogOpen(true)}
              >
                {t("storage.trustedDomains.manage")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsSection>

        {securityMlEnabled ? (
          <SettingsSection>
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
          </SettingsSection>
        ) : null}
      </SettingsSections>

      {securityMlEnabled ? (
        <p className="text-xs text-muted-foreground">
          {t("security.managedByOrg")}
          <br />
          {t("security.warpNotice")}
        </p>
      ) : null}

      <Dialog
        open={trustedDomainsDialogOpen}
        onOpenChange={setTrustedDomainsDialogOpen}
      >
        <DialogContent className="max-w-md gap-5">
          <DialogHeader>
            <DialogTitle>{t("storage.trustedDomains.label")}</DialogTitle>
            <DialogDescription>
              {t("storage.trustedDomains.description")}
            </DialogDescription>
          </DialogHeader>

          {trustedDomains.length > 0 ? (
            <ul
              className="max-h-80 space-y-2 overflow-y-auto pr-1"
              aria-label={t("storage.trustedDomains.listLabel")}
            >
              {trustedDomains.map((domain) => (
                <li
                  key={domain}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm" title={domain}>
                    {domain}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => handleRemoveTrustedDomain(domain)}
                    aria-label={t("storage.trustedDomains.removeAria", {
                      domain,
                    })}
                  >
                    <Trash2 className="size-3.5" />
                    {t("storage.trustedDomains.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-md bg-muted px-3 py-3 text-sm text-muted-foreground">
              {t("storage.trustedDomains.empty")}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClearTrustedDomains}
              disabled={trustedDomains.length === 0}
            >
              <Trash2 className="size-3.5" />
              {t("storage.trustedDomains.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  );
}
