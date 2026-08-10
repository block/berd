import { useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { AgentProviderCard } from "@/features/settings/ui/AgentProviderCard";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import type {
  ProviderCatalogEntry,
  ProviderDisplayInfo,
} from "@/shared/types/providers";
import { OnboardingShell } from "./OnboardingShell";

interface HarnessSetupStepProps {
  provider: ProviderCatalogEntry;
  onBack: () => void;
  initiallyComplete: boolean;
  onSetupComplete: () => void;
  onComplete: () => void;
  onSkip: () => void;
}

export function HarnessSetupStep({
  provider,
  onBack,
  initiallyComplete,
  onSetupComplete,
  onComplete,
  onSkip,
}: HarnessSetupStepProps) {
  const { t } = useTranslation("onboarding");
  const { agentReadiness, agentChecks, loading } = useAgentProviderStatus();
  const [installationComplete, setInstallationComplete] =
    useState(initiallyComplete);
  const markSetupComplete = () => {
    setInstallationComplete(true);
    onSetupComplete();
  };
  const finishReadySetup = () => {
    if (!initiallyComplete) onSetupComplete();
    onComplete();
  };
  const markDemoInstallComplete = () => {
    // Development simulates the complete install + authentication outcome so
    // downstream onboarding integrations exercise provider-ready semantics.
    setInstallationComplete(true);
    onSetupComplete();
  };
  // The development onboarding demo always exercises installation, even on
  // machines where every harness is already present.
  const previewMissing = import.meta.env.DEV;
  const detectedReadiness = agentReadiness.get(provider.id);
  const readiness = previewMissing ? "not_installed" : detectedReadiness;
  const setupReady =
    installationComplete || (!previewMissing && readiness === "ready");
  const displayProvider: ProviderDisplayInfo = {
    ...provider,
    status: setupReady ? "connected" : "not_installed",
  };

  if (setupReady) {
    return (
      <OnboardingShell
        onBack={onBack}
        title={t("setup.readyTitle", { provider: provider.displayName })}
        description={t("setup.readyDescription")}
        actions={
          <Button type="button" onClick={finishReadySetup}>
            {t("setup.finishOnboarding")}
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex size-28 items-center justify-center rounded-full bg-card">
            {getProviderIcon(provider.id, "size-16")}
          </div>
          <div className="flex items-center gap-2 text-foreground">
            <IconCheck className="size-5" aria-hidden="true" />
            <span className="text-sm">{t("setup.installationComplete")}</span>
          </div>
        </div>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell
      onBack={onBack}
      title={
        <span className="inline-flex items-center gap-3">
          {t("setup.installing")} {getProviderIcon(provider.id, "size-9")}{" "}
          {provider.displayName}
        </span>
      }
      description={t("setup.installingDescription", {
        provider: provider.displayName,
      })}
      actions={
        <>
          <Button type="button" disabled>
            {t("setup.finish")}
          </Button>
          <Button type="button" variant="outline" onClick={onSkip}>
            {t("setup.skip")}
          </Button>
        </>
      }
    >
      <div className="w-full max-w-xl">
        <AgentProviderCard
          provider={displayProvider}
          readiness={readiness}
          versionCheck={
            previewMissing ? undefined : agentChecks.get(provider.id)
          }
          statusLoading={loading}
          presentation="card"
          onProviderReady={markSetupComplete}
          onInstallComplete={
            previewMissing ? markDemoInstallComplete : undefined
          }
          autoStartInstall={!initiallyComplete}
          autoInstallProgressOnly
          simulateAutoInstall={previewMissing}
          className="bg-card"
        />
      </div>
    </OnboardingShell>
  );
}
