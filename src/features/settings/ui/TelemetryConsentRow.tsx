import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { Button } from "@/shared/ui/button";
import { SettingsRow } from "@/shared/ui/settings-row";
import { SettingsSection } from "@/shared/ui/settings-section";
import { Switch } from "@/shared/ui/switch";
import {
  ensureTelemetryConsentLoaded,
  telemetryConsentEnforced,
  updateTelemetryEnabled,
  useTelemetryConsentStore,
} from "@/shared/telemetry/consent";
import { UsageDataDialog } from "./UsageDataDialog";

// The telemetry consent toggle: a plain persisted write against the
// Rust-owned setting (default OFF), applied immediately by the per-event and
// native export gates — no restart.
//
// Not rendered at all when consent cannot decide anything:
//   - enforced builds (managed internal distributions), where consent is
//     build policy rather than a user choice;
//   - builds and sessions without the `telemetry` capability
//     (`VITE_TELEMETRY=0`, or `featureToggles.telemetry: false` in runtime
//     config), where the client's own build gate refuses every event — a
//     toggle that cannot produce a single event would let Settings claim
//     sharing the product is incapable of.
// The capability is reactive, so a runtime-config answer arriving mid-session
// takes the row away. Hiding never writes: the persisted choice stays as the
// user left it and comes back with the row if the capability does. The
// matching search entry is hidden in SearchView.tsx.
//
// Not gated on the environment half of that build gate: development builds
// cannot emit either, but the toggle is how a dev session opts in before
// pointing itself at a real gateway.
export function TelemetryConsentRow() {
  const { t } = useTranslation("settings");
  const enforced = telemetryConsentEnforced();
  const available = useProfileCapability("telemetry");
  const hidden = enforced || !available;
  const loaded = useTelemetryConsentStore((state) => state.loaded);
  const enabled = useTelemetryConsentStore((state) => state.enabled);
  const [saving, setSaving] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The consent read normally happens during telemetry init, but that is
  // skipped in dev and consent-disabled sessions — the toggle still has to
  // show the persisted value there. Idempotent, so double-loading is free.
  useEffect(() => {
    if (!hidden) ensureTelemetryConsentLoaded();
  }, [hidden]);

  if (hidden) {
    return null;
  }

  async function handleEnabledChange(next: boolean) {
    setSaving(true);
    try {
      await updateTelemetryEnabled(next);
    } catch (error) {
      console.warn("Failed to update the telemetry setting:", error);
      toast.error(t("privacy.telemetry.saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title={t("privacy.title")}>
      <SettingsRow
        label={t("privacy.telemetry.label")}
        description={
          <>
            {t("privacy.telemetry.description")}{" "}
            <Button
              type="button"
              variant="link"
              className="text-xs"
              onClick={() => setDetailsOpen(true)}
            >
              {t("privacy.telemetry.learnMore")}
            </Button>
          </>
        }
      >
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void handleEnabledChange(next)}
          disabled={!loaded || saving}
          aria-label={t("privacy.telemetry.label")}
        />
      </SettingsRow>
      <UsageDataDialog open={detailsOpen} onOpenChange={setDetailsOpen} />
    </SettingsSection>
  );
}
